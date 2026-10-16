#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { saveSessionLog } from '../core/session-log.mjs';
try { await saveSessionLog(JSON.parse(readFileSync(0, 'utf8') || '{}')); }
catch (error) { process.stderr.write(`save-session-log: ${error.message}\n`); }
