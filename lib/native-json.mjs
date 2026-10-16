// Add/remove owned native registry entries without rewriting the owner's JSONC text.
import { createHash } from 'node:crypto';
import { parseJsonc } from './jsonc.mjs';
const fail=()=>{throw new Error('Invalid or ambiguous native JSON/JSONC; original preserved');};
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
export const nativeEntryHash=value=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
function inspect(bytes) {
  const text=bytes.toString('utf8');if(!Buffer.from(text).equals(bytes)) fail();
  let data;try{data=parseJsonc(text);}catch{fail();}
  if(!data||typeof data!=='object'||Array.isArray(data)) fail();
  let at=0;
  function space() {while(at<text.length) {
    if(/\s/.test(text[at])) at++;
    else if(text.slice(at,at+2)==='//') {while(at<text.length&&text[at]!=='\n') at++;}
    else if(text.slice(at,at+2)==='/*') {const end=text.indexOf('*/',at+2);if(end<0)fail();at=end+2;}
    else break;
  }}
  function string() {const start=at++;let escape=false;
    while(at<text.length) {const char=text[at++];if(escape)escape=false;else if(char==='\\')escape=true;else if(char==='"')return JSON.parse(text.slice(start,at));}fail();}
  function node() {
    space();const start=at;
    if(text[at]==='{') {
      at++;space();const properties=[],names=new Set();
      while(text[at]!=='}') {
        const keyStart=at;if(text[at]!=='"')fail();const name=string();if(names.has(name))fail();names.add(name);
        space();if(text[at++]!==':')fail();const value=node();space();
        const property={name,keyStart,value};if(text[at]===','){property.comma=at++;space();}
        properties.push(property);if(property.comma===undefined&&text[at]!=='}')fail();
      }
      at++;return {start,end:at,properties};
    }
    if(text[at]==='[') {
      at++;space();const elements=[];
      while(text[at]!==']'){const value=node();space();if(text[at]===','){value.comma=at++;space();}else if(text[at]!==']')fail();elements.push(value);}
      at++;return {start,end:at,elements};
    }
    else if(text[at]==='"') string();
    else {while(at<text.length&&!/[\s,\]}]/.test(text[at])&&text.slice(at,at+2)!=='//'&&text.slice(at,at+2)!=='/*')at++;}
    if(at===start)fail();return {start,end:at};
  }
  const root=node();space();if(at!==text.length)fail();return {text,data,root};
}
function objectAt(tree,container) {
  const property=tree.root.properties.find(entry=>entry.name===container);
  if(!property)return null;if(!property.value.properties)fail();return property.value;
}
export function readNativeJson(bytes) {return inspect(bytes).data;}
function valueAt(tree,path) {
  let node=tree.root,data=tree.data;
  for(const key of path) {
    node=typeof key==='number'?node.elements?.[key]:node.properties?.find(entry=>entry.name===key)?.value;
    if(!node)return null;data=data[key];
  }
  return {node,data};
}
export function removeNativeArrayValues(bytes,path,hashes) {
  let text=inspect(bytes).text;
  for(;;) {
    const tree=inspect(Buffer.from(text)),value=valueAt(tree,path);if(!value)return Buffer.from(text);
    if(!Array.isArray(value.data)||!value.node.elements)fail();
    const index=value.data.findIndex(entry=>hashes.includes(nativeEntryHash(entry)));if(index<0)return Buffer.from(text);
    const target=value.node.elements[index],previous=value.node.elements[index-1];
    const start=target.comma===undefined&&previous?previous.comma:target.start,end=target.comma===undefined?target.end:target.comma+1;
    text=text.slice(0,start)+text.slice(end);
  }
}
export function removeNativeObjectValue(bytes,path,hash) {
  const tree=inspect(bytes),parent=valueAt(tree,path.slice(0,-1));if(!parent||!Object.hasOwn(parent.data,path.at(-1)))return bytes;
  if(nativeEntryHash(parent.data[path.at(-1)])!==hash)throw new Error('Native value is not a proved legacy definition');
  return Buffer.from(removeProperty(tree.text,parent.node,path.at(-1)));
}
function append(text,object,entries) {
  const last=object.properties.at(-1),prefix=last&&last.comma===undefined?',':'';
  const insertion=prefix+Object.entries(entries).map(([name,value])=>JSON.stringify(name)+':'+JSON.stringify(value)).join(',');
  return text.slice(0,object.end-1)+insertion+text.slice(object.end-1);
}
function removeProperty(text,object,name) {
  const index=object.properties.findIndex(entry=>entry.name===name);if(index<0)fail();
  const target=object.properties[index],previous=object.properties[index-1];
  const start=target.comma===undefined&&previous?previous.comma:target.keyStart;
  const end=target.comma===undefined?target.value.end:target.comma+1;
  return text.slice(0,start)+text.slice(end);
}
export function addNativeJsonEntries(original,container,entries) {
  const bytes=original??Buffer.from('{}\n'),tree=inspect(bytes),object=objectAt(tree,container);
  if(Object.keys(entries).length===0)throw new Error('Empty native registry addition');
  if(object&&Object.keys(entries).some(name=>Object.hasOwn(tree.data[container],name))) throw new Error('Native registry entry already belongs to the project');
  const text=object?append(tree.text,object,entries):append(tree.text,tree.root,{[container]:entries});
  inspect(Buffer.from(text));
  return {bytes:Buffer.from(text),patch:{type:'native-json',container,had_container:Boolean(object),
    entries:Object.fromEntries(Object.entries(entries).map(([name,value])=>[name,nativeEntryHash(value)]))}};
}
export function stripNativeJsonEntries(bytes,patch) {
  if(patch.type!=='native-json'||typeof patch.container!=='string'||typeof patch.had_container!=='boolean'
    ||!patch.entries||typeof patch.entries!=='object'||Array.isArray(patch.entries))fail();
  let text=inspect(bytes).text;
  for(const [name,hash] of Object.entries(patch.entries)) {
    const tree=inspect(Buffer.from(text)),object=objectAt(tree,patch.container);
    if(!object||!Object.hasOwn(tree.data[patch.container],name)||!/^[a-f0-9]{64}$/.test(hash)||nativeEntryHash(tree.data[patch.container][name])!==hash)
      throw new Error('Owned native registry entry changed; original preserved');
    text=removeProperty(text,object,name);
  }
  const tree=inspect(Buffer.from(text)),object=objectAt(tree,patch.container);
  if(object&&!patch.had_container&&object.properties.length===0)text=removeProperty(text,tree.root,patch.container);
  inspect(Buffer.from(text));return Buffer.from(text);
}

// Keep owner text in place; the receipt records hashes of additions, never owner values.
const validPath=path=>Array.isArray(path)&&path.length>0&&path.every(key=>typeof key==='string'&&key.length>0);
export function addNativeJsonChanges(original,{values=[],arrays=[]}={}) {
  let bytes=original??Buffer.from('{}\n');inspect(bytes);
  const patch={type:'native-json-delta',objects:[],values:[],arrays:[]};
  function parent(path) {
    if(!validPath(path))fail();
    for(let depth=1;depth<path.length;depth++) {
      const prefix=path.slice(0,depth),tree=inspect(bytes),existing=valueAt(tree,prefix);
      if(existing) {if(!existing.node.properties)fail();continue;}
      const object=depth===1?tree.root:valueAt(tree,prefix.slice(0,-1)).node;
      bytes=Buffer.from(append(tree.text,object,{[prefix.at(-1)]:{}}));patch.objects.push(prefix);
    }
    const tree=inspect(bytes);return {tree,node:path.length===1?tree.root:valueAt(tree,path.slice(0,-1)).node};
  }
  for(const {path,value} of values) {
    const {tree,node}=parent(path);if(valueAt(tree,path))throw new Error('Native field already belongs to the project');
    bytes=Buffer.from(append(tree.text,node,{[path.at(-1)]:value}));patch.values.push({path,hash:nativeEntryHash(value)});
  }
  for(const {path,values:added} of arrays) {
    if(!Array.isArray(added)||added.length===0)fail();
    const {tree,node}=parent(path),current=valueAt(tree,path);
    if(current) {
      if(!current.node.elements)fail();
      const last=current.node.elements.at(-1),prefix=last&&last.comma===undefined?',':'';
      const at=current.node.end-1;
      bytes=Buffer.from(tree.text.slice(0,at)+prefix+added.map(value=>JSON.stringify(value)).join(',')+tree.text.slice(at));
    } else bytes=Buffer.from(append(tree.text,node,{[path.at(-1)]:added}));
    patch.arrays.push({path,had_array:Boolean(current),hashes:added.map(nativeEntryHash)});
  }
  inspect(bytes);return {bytes,patch};
}
export function stripNativeJsonChanges(bytes,patch) {
  if(patch.type!=='native-json-delta'||!Array.isArray(patch.objects)||!Array.isArray(patch.values)||!Array.isArray(patch.arrays))fail();
  const owned=()=>{throw new Error('Owned native setting changed; original preserved');};
  for(const {path,hash} of patch.values) {
    if(!validPath(path)||!/^[a-f0-9]{64}$/.test(hash))fail();
    const value=valueAt(inspect(bytes),path);if(!value||nativeEntryHash(value.data)!==hash)owned();
    bytes=removeNativeObjectValue(bytes,path,hash);
  }
  for(const {path,had_array,hashes} of patch.arrays) {
    if(!validPath(path)||typeof had_array!=='boolean'||!Array.isArray(hashes)||!hashes.length||hashes.some(hash=>!/^[a-f0-9]{64}$/.test(hash)))fail();
    const value=valueAt(inspect(bytes),path);
    if(!value||!Array.isArray(value.data)||hashes.some(hash=>value.data.filter(item=>nativeEntryHash(item)===hash).length!==1))owned();
    bytes=removeNativeArrayValues(bytes,path,hashes);
    if(!had_array&&valueAt(inspect(bytes),path).data.length===0)bytes=removeNativeObjectValue(bytes,path,nativeEntryHash([]));
  }
  for(const path of [...patch.objects].reverse()) {
    if(!validPath(path))fail();const value=valueAt(inspect(bytes),path);
    if(value?.node.properties?.length===0)bytes=removeNativeObjectValue(bytes,path,nativeEntryHash({}));
  }
  return bytes;
}
