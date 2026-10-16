// A strict, dependency-free TOML subset for native tool definitions.
// Unsupported values fail before adaptation; errors never contain configuration values.
export function parseToml(text) {
  if(typeof text!=='string'||text.includes('\0')) throw new Error('Invalid native TOML');
  let at=0;
  const root=Object.create(null),declared=new Set(),sealed=new WeakSet();
  const fail=()=>{throw new Error('Unsupported or invalid native TOML');};
  const whitespace=()=>{while(at<text.length) {if(/\s/.test(text[at])) at++;else if(text[at]==='#') {while(at<text.length&&text[at]!=='\n') at++;}else break;}};
  const spaces=()=>{while(text[at]===' '||text[at]==='\t') at++;};
  function string() {
    const quote=text[at],triple=text.slice(at,at+3)===quote.repeat(3);at+=triple?3:1;
    if(triple) {if(text.slice(at,at+2)==='\r\n') at+=2;else if(text[at]==='\n') at++;}
    let value='';
    while(at<text.length) {
      if(triple?text.slice(at,at+3)===quote.repeat(3):text[at]===quote) {at+=triple?3:1;return value;}
      const char=text[at++];
      if(!triple&&(char==='\n'||char==='\r')) fail();
      if(quote==="'"||char!=='\\') {if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(char)) fail();value+=char;continue;}
      if(triple&&/[\t \r\n]/.test(text[at]||'')) {while(/\s/.test(text[at]||'')) at++;continue;}
      const escape=text[at++],basic={b:'\b',t:'\t',n:'\n',f:'\f',r:'\r','"':'"','\\':'\\'};
      if(Object.hasOwn(basic,escape)) {value+=basic[escape];continue;}
      if(escape==='u'||escape==='U') {
        const length=escape==='u'?4:8,hex=text.slice(at,at+length);if(!new RegExp('^[0-9a-fA-F]{'+length+'}$').test(hex)) fail();
        const point=parseInt(hex,16);if(point>0x10ffff||(point>=0xd800&&point<=0xdfff)) fail();
        value+=String.fromCodePoint(point);at+=length;continue;
      }
      fail();
    }
    fail();
  }
  function keys() {
    const result=[];
    while(true) {
      spaces();let key;
      if(text[at]==='"'||text[at]==="'") key=string();
      else {key=/^[A-Za-z0-9_-]+/.exec(text.slice(at))?.[0];if(!key) fail();at+=key.length;}
      if(['__proto__','constructor','prototype'].includes(key)) fail();
      result.push(key);spaces();if(text[at]!=='.') return result;at++;
    }
  }
  function assign(object,path,value) {
    for(const key of path.slice(0,-1)) {
      if(!Object.hasOwn(object,key)) object[key]=Object.create(null);
      object=object[key];if(!object||typeof object!=='object'||Array.isArray(object)||sealed.has(object)) fail();
    }
    const key=path.at(-1);if(Object.hasOwn(object,key)||sealed.has(object)) fail();object[key]=value;
  }
  function value() {
    spaces();
    if(text[at]==='"'||text[at]==="'") return string();
    if(text[at]==='[') {
      at++;const result=[];whitespace();
      while(text[at]!==']') {result.push(value());whitespace();if(text[at]!==',') {if(text[at]!==']') fail();break;}at++;whitespace();}
      at++;return result;
    }
    if(text[at]==='{') {
      at++;const result=Object.create(null);spaces();
      while(text[at]!=='}') {const path=keys();if(text[at++]!=='=') fail();assign(result,path,value());spaces();if(text[at]!==',') {if(text[at]!=='}') fail();break;}at++;spaces();if(text[at]==='}') fail();}
      at++;sealed.add(result);return result;
    }
    const token=/^[^\s,\]}#]+/.exec(text.slice(at))?.[0];if(!token) fail();at+=token.length;
    if(token==='true'||token==='false') return token==='true';
    if(/^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$/.test(token)) {
      const number=Number(token.replaceAll('_',''));if(!Number.isFinite(number)) fail();return number;
    }
    if(/^0(?:x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(token)) return Number(token.replaceAll('_',''));
    fail();
  }
  let table=root;
  while(true) {
    whitespace();if(at===text.length) return root;
    if(text[at]==='[') {
      at++;if(text[at]==='[') fail();const path=keys();if(text[at++]!==']') fail();
      const id=JSON.stringify(path);if(declared.has(id)) fail();declared.add(id);table=root;
      for(const key of path) {
        if(!Object.hasOwn(table,key)) table[key]=Object.create(null);
        table=table[key];if(!table||typeof table!=='object'||Array.isArray(table)||sealed.has(table)) fail();
      }
    } else {const path=keys();if(text[at++]!=='=') fail();assign(table,path,value());}
    spaces();if(text[at]==='#') {while(at<text.length&&text[at]!=='\n') at++;}
    if(at<text.length&&text[at]!=='\n'&&text[at]!=='\r') fail();
  }
}
