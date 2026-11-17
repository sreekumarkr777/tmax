// Git helpers: repo detection, branch names, and worktree creation.
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

async function repoInfo(cwd) {
  try {
    const top = await git(cwd, ['rev-parse', '--show-toplevel']);
    const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']).catch(() => top);
    const branch = await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
    return { isRepo: true, top, repoKey: common, branch };
  } catch {
    return { isRepo: false, top: cwd, repoKey: null, branch: null };
  }
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'agent';
}

/**
 * Create a worktree next to the repo: <parent>/<repo>.worktrees/<slug>
 * on a new branch sb/<slug>. Returns { dir, branch }.
 */
async function createWorktree(repoTop, name) {
  const slug = slugify(name);
  const baseDir = path.join(path.dirname(repoTop), `${path.basename(repoTop)}.worktrees`);
  fs.mkdirSync(baseDir, { recursive: true });
  let dir = path.join(baseDir, slug);
  let branch = `sb/${slug}`;
  for (let i = 2; fs.existsSync(dir); i++) {
    dir = path.join(baseDir, `${slug}-${i}`);
    branch = `sb/${slug}-${i}`;
  }
  const exists = await git(repoTop, ['rev-parse', '--verify', '--quiet', branch]).then(() => true, () => false);
  if (exists) await git(repoTop, ['worktree', 'add', dir, branch]);
  else await git(repoTop, ['worktree', 'add', '-b', branch, dir]);
  return { dir, branch };
}

async function currentBranch(cwd) {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => null);
}

module.exports = { repoInfo, createWorktree, currentBranch, slugify };
