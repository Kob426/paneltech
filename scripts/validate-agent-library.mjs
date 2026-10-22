#!/usr/bin/env node
// Deliberately validates the small, quoted YAML subset used by this local library.
// It is not a general YAML parser or proof of skill quality/runtime discovery.
import { readFileSync, readdirSync, realpathSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname, relative, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = path => readFileSync(path, 'utf8');
const pkg = JSON.parse(read(join(root, 'package.json')));
const skillRoot = join(root, 'skills');
const skills = readdirSync(skillRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
assert(skills.length > 0, 'No project skills found');
const files = ['AGENTS.md', 'SOUL.md', 'USER.md', 'DESIGN.md', 'docs/AGENT-AND-SKILLS-AUDIT.md', 'docs/PDF-REVIEW.md'];

for (const name of skills) {
  assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) && name.length <= 64, `Invalid name: ${name}`);
  const skillPath = join(skillRoot, name, 'SKILL.md');
  const text = read(skillPath);
  const front = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(front, `${name}: missing YAML frontmatter`);
  const rows = front[1].split('\n');
  assert.equal(rows.length, 2, `${name}: expected only name and description`);
  assert.equal(rows[0], `name: ${name}`, `${name}: name mismatch`);
  assert(rows[1].startsWith('description: '), `${name}: missing description`);
  const description = JSON.parse(rows[1].slice('description: '.length));
  assert(typeof description === 'string' && description.length > 20 && description.length <= 1024, `${name}: invalid description`);
  assert(!/[<>]/.test(description), `${name}: angle brackets in description`);
  assert(!/\bTODO\b|\[insert|\[название/i.test(text), `${name}: unfinished template`);
  assert(text.split('\n').length <= 120, `${name}: move detail to references`);
  const metadata = read(join(skillRoot, name, 'agents/openai.yaml'));
  assert(metadata.startsWith('interface:\n'), `${name}: missing interface`);
  const values = {};
  for (const line of metadata.trimEnd().split('\n').slice(1)) {
    const m = line.match(/^  ([a-z_]+): (".*")$/);
    assert(m, `${name}: unsupported metadata syntax`);
    values[m[1]] = JSON.parse(m[2]);
  }
  for (const key of ['display_name', 'short_description', 'default_prompt']) assert(values[key], `${name}: missing ${key}`);
  assert(values.short_description.length >= 25 && values.short_description.length <= 64, `${name}: short description length`);
  assert(values.default_prompt.includes(`$${name}`), `${name}: prompt must mention skill`);
  files.push(relative(root, skillPath));
}

assert(lstatSync(join(root, '.agents/skills')).isSymbolicLink(), 'Expected a single skills discovery symlink');
assert.equal(realpathSync(join(root, '.agents/skills')), realpathSync(skillRoot), 'Discovery symlink points to another library');
let links = 0;
for (const file of files) {
  const text = read(join(root, file));
  for (const m of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) continue;
    const path = resolve(dirname(join(root, file)), decodeURIComponent(target.split('#')[0]));
    const rel = relative(root, path);
    assert(!rel.startsWith('..') && !isAbsolute(rel), `${file}: link escapes checkout: ${target}`);
    assert(existsSync(path), `${file}: broken link: ${target}`);
    links++;
  }
  for (const m of text.matchAll(/npm run ([a-z][a-z0-9:-]*)/g)) assert(pkg.scripts[m[1]], `${file}: missing npm script ${m[1]}`);
}
assert(read(join(root, 'AGENTS.md')).split('\n').length <= 150, 'AGENTS.md should stay a concise map');
console.log(`PASS: ${skills.length} skill frontmatters + UI metadata, ${links} local links, npm command references, context budgets and discovery symlink`);
console.log('Filesystem validation only; client UI registration and future task behavior are not proven by this check.');
