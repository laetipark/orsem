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
const htmlAnchor = /<a\b[^>]*\s(?:id|name)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi;

function headingSlug(heading) {
  const text = heading
    .replace(/<[^>]*>/g, '')
    .replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(`+)(.*?)\1/g, '$2')
    .replace(/\\([\\`*_{}\[\]()#+.!-])/g, '$1')
    .replace(/[*~]/g, '')
    .replace(/(^|\s)_{1,2}([^_]+)_{1,2}(?=\s|$)/g, '$1$2')
    .trim()
    .toLowerCase();
  // GitHub removes punctuation (including the middle dot) without inserting
  // a separator, then turns spaces into hyphens. Preserve Korean text.
  return text.replace(/[^\p{L}\p{N}\p{M}_\s-]/gu, '').replace(/ /g, '-');
}

function markdownAnchors(source) {
  const anchors = new Set();
  const counts = new Map();
  let fence = null;
  let previous = '';
  const addHeading = (heading) => {
    const base = headingSlug(heading);
    let slug = base;
    let suffix = counts.get(base) ?? 0;
    while (anchors.has(slug)) slug = `${base}-${++suffix}`;
    counts.set(base, suffix);
    anchors.add(slug);
  };

  for (const line of source.split(/\r?\n/)) {
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
      previous = '';
      continue;
    }
    if (marker) {
      fence = marker[1];
      previous = '';
      continue;
    }

    const prose = line.replace(/(`+).*?\1/g, '');
    for (const match of prose.matchAll(htmlAnchor)) anchors.add(match[1] ?? match[2] ?? match[3]);
    const heading = line.match(/^ {0,3}#{1,6}(?:[ \t]+|$)(.*)$/);
    if (heading) {
      addHeading(heading[1].replace(/[ \t]+#+[ \t]*$/, ''));
    } else if (/^ {0,3}(?:=+|-+)[ \t]*$/.test(line) && previous) {
      addHeading(previous);
    }
    previous = /^\s*$/.test(line) || heading ? '' : line.trim();
  }
  return anchors;
}

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

export function checkMarkdown(source, filename, root, exists = existsSync, read = readFileSync) {
  const issues = [];
  let fence = null;
  const anchorsByFile = new Map([[filename, markdownAnchors(source)]]);
  const relativeFile = path.relative(root, filename).split(path.sep).join('/');
  const add = (line, message) => issues.push(`${relativeFile}:${line}: ${message}`);
  const checkLink = (raw, line) => {
    const target = raw.replace(/^<|>$/g, '').replace(/\\([\\ ()])/g, '$1');
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return;
    const hash = target.indexOf('#');
    const pathname = (hash < 0 ? target : target.slice(0, hash)).split('?', 1)[0];
    const fragment = hash < 0 ? '' : target.slice(hash + 1);
    let decodedPath;
    let decodedFragment;
    try {
      decodedPath = decodeURIComponent(pathname);
      decodedFragment = decodeURIComponent(fragment);
    } catch {
      add(line, `Invalid link encoding: ${target}`);
      return;
    }
    const resolved = pathname ? path.resolve(path.dirname(filename), decodedPath) : filename;
    const relativeTarget = path.relative(root, resolved);
    if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)) {
      add(
        line,
        `External filesystem links are not portable; describe the relative path as text: ${target}`,
      );
    } else if (pathname && !exists(resolved)) {
      add(line, `Missing relative link target: ${target}`);
    } else if (fragment && /\.md$/i.test(resolved)) {
      let anchors = anchorsByFile.get(resolved);
      if (!anchors) {
        try {
          anchors = markdownAnchors(read(resolved, 'utf8'));
          anchorsByFile.set(resolved, anchors);
        } catch {
          add(line, `Unreadable Markdown link target: ${target}`);
          return;
        }
      }
      if (!anchors.has(decodedFragment)) add(line, `Missing Markdown anchor: ${target}`);
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
    console.log(
      `Checked paths, local file links and Markdown anchors in ${result.count} Markdown files.`,
    );
  }
}
