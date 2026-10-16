import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join, win32 } from 'node:path';
import { randomUUID } from 'node:crypto';

// A real Windows reader that permits reads but temporarily refuses replacement/deletion.
export async function holdWindowsReadLock(file, durationMs = 120) {
  const script = join(dirname(file), '.reader-' + randomUUID() + '.ps1');
  writeFileSync(script, 'param([string]$file,[int]$duration)\n'
    + '$stream=[System.IO.File]::Open($file,[System.IO.FileMode]::Open,[System.IO.FileAccess]::Read,[System.IO.FileShare]::Read)\n'
    + 'try { [Console]::Out.WriteLine("READY"); [Console]::Out.Flush(); '
    + 'if($duration -gt 0){Start-Sleep -Milliseconds $duration}else{[Console]::In.ReadLine() | Out-Null} } '
    + 'finally { $stream.Dispose() }\n');
  const powershell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-File', script, file, String(durationMs)], { windowsHide: true });
  const closed = new Promise(resolve => child.once('exit', code => { unlinkSync(script); resolve(code); }));
  let backstop = setTimeout(() => child.kill(), 5000);
  closed.finally(() => clearTimeout(backstop));
  await new Promise((resolve, reject) => {
    let text = '', ready = false;
    child.once('error', reject);
    child.stdout.on('data', data => { text += data; if (!ready && text.includes('READY')) { ready = true; clearTimeout(backstop); resolve(); } });
    child.once('exit', () => { if (!ready) reject(new Error('Windows reader did not acquire its lock')); });
  });
  return { closed, release: () => {
    // Timed readers close themselves. Writing after that close produced EPIPE under full load.
    if(durationMs>0||child.exitCode!==null||child.signalCode)return;
    backstop=setTimeout(()=>child.kill(),5000);child.stdin.end('\n');
  } };
}
