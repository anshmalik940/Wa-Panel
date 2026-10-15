#!/usr/bin/env node
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const { config } = require('../src/config');
const { resetAdminCredentials } = require('../src/services/adminCredentialReset');
const { mongoose } = require('../src/db');

async function readHidden(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') {
    throw new Error('Run this command from an interactive terminal so the password can be entered without echoing it.');
  }

  return new Promise((resolve, reject) => {
    let value = '';
    let previousRawMode = stdin.isRaw;
    let ignoreLineFeed = false;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();

    const finish = (error) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(previousRawMode);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (ignoreLineFeed && character === '\n') {
          ignoreLineFeed = false;
          continue;
        }
        ignoreLineFeed = false;
        if (character === '\u0003') {
          finish(new Error('Cancelled.'));
          return;
        }
        if (character === '\r' || character === '\n') {
          ignoreLineFeed = character === '\r';
          finish();
          return;
        }
        if (character === '\u007f' || character === '\b') {
          value = Array.from(value).slice(0, -1).join('');
          continue;
        }
        if (character >= ' ') {
          value += character;
          stdout.write('*');
        }
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  let currentEmail;
  let newEmail;
  try {
    currentEmail = (await terminal.question('Existing admin email: ')).trim();
    newEmail = (await terminal.question('New admin email (Enter to keep current): ')).trim() || currentEmail;
  } finally {
    terminal.close();
  }

  const password = await readHidden('New admin password (hidden): ');
  const confirmation = await readHidden('Confirm new admin password (hidden): ');
  if (password !== confirmation) throw new Error('The passwords do not match.');

  await mongoose.connect(config.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  try {
    await resetAdminCredentials({ currentEmail, newEmail, password });
    console.log('Existing admin credentials updated. All existing sessions for that admin have been invalidated.');
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(`[admin-reset] ${error.message}`);
  process.exitCode = 1;
});
