import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = fileURLToPath(new URL('../', import.meta.url));
const excludedDirectories = new Set(['node_modules', 'dist', 'build', 'coverage', '__pycache__']);

export function markdownFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name.startsWith('.') || excludedDirectories.has(entry.name)) return [];
    const filename = path.join(root, entry.name);
    if (entry.isDirectory()) return markdownFiles(filename);
    return entry.isFile() && /\.md$/i.test(entry.name) ? [filename] : [];
  });
}

// HTTP routes and URLs are not filesystem paths. Relative paths to external data
// and runtime-resolved paths such as "$PWD/../orsem-data" remain valid.
const absolutePath =
  /(?<![\w./:$-])(?:\/(?:home|Users|tmp|opt|var|etc|usr|path|srv|mnt|workspace)\/|[A-Za-z]:[\\/]|~\/|file:\/\/)/g;
const remoteUrl = /https?:\/\/[^\s<>"'`]+|(?<![:/])\/\/[^\s<>"'`]+/g;
const inlineLink = /!?\[[^\]\n]*\]\(\s*/g;
const referenceLink = /^ {0,3}\[[^\]]+\]:\s*/;

function readDestination(text, start) {
  const angle = text[start] === '<';
  let depth = 0;
  for (let index = start + Number(angle); index < text.length; index += 1) {
    const character = text[index];
    if (character === '\\') {
      index += 1;
    } else if (angle) {
      if (character === '>') return text.slice(start, index + 1);
    } else if (/\s/.test(character) || (character === ')' && depth === 0)) {
      return depth === 0 ? text.slice(start, index) : null;
    } else if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
    }
  }
  return !angle && depth === 0 ? text.slice(start) : null;
}

export function checkMarkdown(source, filename, root, exists = existsSync) {
  const issues = [];
  let fence = null;
  const relativeFile = path.relative(root, filename).split(path.sep).join('/');
  const add = (line, message) => issues.push(`${relativeFile}:${line}: ${message}`);
  const checkLink = (raw, line) => {
    const target = raw.replace(/^<|>$/g, '').replace(/\\([\\ ()])/g, '$1');
    if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(target)) return;
    const pathname = target.split(/[?#]/, 1)[0];
    if (!pathname) return;
    let decoded;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      add(line, `Invalid link encoding: ${target}`);
      return;
    }
    const resolved = path.resolve(path.dirname(filename), decoded);
    const relativeTarget = path.relative(root, resolved);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)) {
      add(
        line,
        `External filesystem links are not portable; describe the relative path as text: ${target}`,
      );
    } else if (!exists(resolved)) {
      add(line, `Missing relative link target: ${target}`);
    }
  };

  source.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.replace(remoteUrl, '').matchAll(absolutePath)) {
      add(index + 1, `Use a project-root relative filesystem path instead of ${match[0]}`);
    }
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (
        marker &&
        marker[1][0] === fence[0] &&
        marker[1].length >= fence.length &&
        !marker[2].trim()
      ) {
        fence = null;
      }
      return;
    }
    if (marker) {
      fence = marker[1];
      return;
    }
    const prose = line.replace(/(`+).*?\1/g, '');
    for (const match of prose.matchAll(inlineLink)) {
      const target = readDestination(prose, match.index + match[0].length);
      if (target) checkLink(target, index + 1);
    }
    const reference = prose.match(referenceLink);
    if (reference) {
      const target = readDestination(prose, reference[0].length);
      if (target) checkLink(target, index + 1);
    }
  });
  return issues;
}

export function checkDocs(root = repository) {
  const files = markdownFiles(root).sort();
  return {
    count: files.length,
    issues: files.flatMap((filename) =>
      checkMarkdown(readFileSync(filename, 'utf8'), filename, root),
    ),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = checkDocs();
  if (result.issues.length) {
    console.error(result.issues.join('\n'));
    process.exitCode = 1;
  } else {
    console.log(`Checked paths and local file links in ${result.count} Markdown files.`);
  }
}
