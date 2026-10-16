// JSON with comments and trailing commas. Strings keep their bytes; no input is executed.
export function parseJsonc(text) {
  let clean='',string=false,escaped=false,line=false,block=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i],next=text[i+1];
    if(line) { if(char==='\n' || char==='\r') { line=false;clean+=char; } continue; }
    if(block) { if(char==='*' && next==='/') { block=false;i++; } else if(char==='\n'||char==='\r') clean+=char; continue; }
    if(string) {
      clean+=char;
      if(escaped) escaped=false;
      else if(char==='\\') escaped=true;
      else if(char==='"') string=false;
      continue;
    }
    if(char==='"') { string=true;clean+=char; }
    else if(char==='/' && next==='/') { line=true;clean+=' ';i++; }
    else if(char==='/' && next==='*') { block=true;clean+=' ';i++; }
    else clean+=char;
  }
  if(block) throw new Error('Unterminated JSON comment');
  let normalized='';string=false;escaped=false;
  for(let i=0;i<clean.length;i++) {
    const char=clean[i];
    if(string) {
      normalized+=char;
      if(escaped) escaped=false;
      else if(char==='\\') escaped=true;
      else if(char==='"') string=false;
    } else if(char==='"') { string=true;normalized+=char; }
    else if(char===',') {
      let next=i+1;while(/\s/.test(clean[next]||'') && next<clean.length) next++;
      if(clean[next]!==']' && clean[next]!=='}') normalized+=char;
    } else normalized+=char;
  }
  return JSON.parse(normalized);
}
