/**
 * NOTES
 * 
 * @octokit/rest
 *   pros:
 *     - can get user information (including repos root)
 *     - can create a new repo/remote
 *     - has Typescript definitions
 *   cons:
 *     - has no facility to clone a repo
 *     - commits require tree/SHA calculation (no high level "add file")
 * 
 * nodegit
 *   pros:
 *     - can clone a repo
 *       - see https://gist.github.com/getify/f5b111381413f9d9f4b2571c7d5822ce
 *     - has Typescript definitions (`npm install @types/nodegit --save`)
 *   cons:
 *     - cannot create a repo
 *     - low level commit requires index manipulation (no high level "add file")
 *       - see https://github.com/nodegit/nodegit/blob/master/examples/add-and-commit.js
 *     - authentication with token uses `https://${token}:x-oauth-basic@github.com/${repository}`
 *       which the GitHub API docs do not mention
 * 
 * github-api
 *   pros:
 *     - can create a repo
 *   cons:
 *     - cannot clone a repo
 *     - commits require tree/SHA (no high level "add file")
 *       - see http://github-tools.github.io/github/docs/3.1.0/Repository.html#createRef
 *     - no Typescript definitions
 * 
 * octonode
 *   pros:
 *     - can get user information
 *     - can create a repo
 *   cons:
 *     - cannot clone a repo
 *     - async is a little kludgy
 *       - see https://github.com/pksunkara/octonode#async--promises
 *     - no Typescript definitions
 */
import * as Path from 'path';
import * as fse from 'fs-extra';

import * as GitHub from '@octokit/rest';
import * as Git from 'nodegit';
import * as Yargs from 'yargs';

function constructLocalPath(root: string, repo: string): string {
  return Path.join(root, repo);
}

function getGitHubUser(token: string): Promise<any> {
  const github = new GitHub();
  github.authenticate({ type: 'token', token });
  return github.users.get({}).then(x => x.data);
}

function createGitHubRepo(token: string, owner: string, repo: string): Promise<GitHub.CreateResponse> {
  const github = new GitHub();
  github.authenticate({ type: 'token', token });

  const params: GitHub.ReposCreateParams = {
    name: repo,
    auto_init: true,
  };
  return github.repos.create(params).then(x => x.data);
}

async function getGitHubRepo(token: string, owner: string, repo: string): Promise<GitHub.GetResponse> {
  try {
    const github = new GitHub();
    github.authenticate({ type: 'token', token });
    const params: GitHub.ReposGetParams = { owner, repo };
    return await github.repos.get(params).then(x => x.data);
  }
  catch (err) {
    if (err.code === 404) {
      return undefined;
    }
    throw (err);
  }
}

function deleteGitHubRepo(token: string, owner: string, repo: string): Promise<GitHub.DeleteResponse> {
  const github = new GitHub();
  github.authenticate({ type: 'token', token });
  const params: GitHub.ReposDeleteParams = { owner, repo };
  return github.repos.delete(params).then(x => x.data);
}

function cloneRepo(token: string, url: string, localPath: string): Promise<Git.Repository> {
  const options: Git.CloneOptions = {
    fetchOpts: {
      callbacks: {
        certificateCheck: () => 1,
        credentials: () => Git.Cred.userpassPlaintextNew(token, 'x-oauth-basic')
      }
    }
  };
  console.log(`Cloning ${url} into ${localPath}`);
  return Git.Clone.clone(url, localPath, options);
}

async function provisionExistingRepo(token: string, owner: string, repo: string, localPath: string): Promise<Git.Repository> {
  const localExists = fse.existsSync(localPath);
  if (localExists) {
    throw new Error('Local path already exists.');
  }

  const existingRepo = await getGitHubRepo(token, owner, repo);
  if (existingRepo) {
    console.log('Cloning repo...')
    await fse.ensureDir(localPath);
    const provisioned = await cloneRepo(token, existingRepo.clone_url, localPath);
    console.log(`Cloned repo ${repo} into ${localPath}`);
    console.log('Done.');
    return provisioned;
  }
  throw new Error(`Repository ${owner}/${repo} not found.`);
}

async function provisionNewRepo(token: string, owner: string, repo: string, localPath: string): Promise<Git.Repository> {
  const localExists = fse.existsSync(localPath);
  if (localExists) {
    throw new Error('Local path already exists.');
  }

  const existingRepo = await getGitHubRepo(token, owner, repo);
  if (!existingRepo) {
    console.log('Creating repo in GitHub...');
    const created = await createGitHubRepo(token, owner, repo);
    console.log(`Created GitHub repo: ${created.url}`);
    const provisioned = await provisionExistingRepo(token, owner, repo, localPath);
    console.log('Done.');
    return provisioned;
  }
  throw new Error(`Repository ${owner}/${repo} already exists`);
}

async function removeRepo(token: string, owner: string, repo: string, localPath: string): Promise<void> {
  const existingRepo = await getGitHubRepo(token, owner, repo);
  if (existingRepo) {
    console.log('Deleting GitHub repo...');
    await deleteGitHubRepo(token, owner, repo);
    console.log(`Deleted repo: ${repo}`);
  }

  const localExists = fse.existsSync(localPath);
  if (localExists) {
    console.log('Deleting local path...');
    await fse.remove(localPath);
    console.log(`Deleted ${localPath}`);
  }

  console.log('Done.');
}

async function processCreateCommand(args: Yargs.Arguments) {
  const { token, repo, root } = args;
  const localPath: string = constructLocalPath(root, repo);

  const { login: owner } = await getGitHubUser(token);
  const created = await provisionNewRepo(token, owner, repo, localPath);
  return created;
}

async function processDeleteCommand(args: Yargs.Arguments) {
  const { token, repo, root } = args;
  const localPath: string = constructLocalPath(root, repo);

  const { login: owner } = await getGitHubUser(token);
  const deleted = await removeRepo(token, owner, repo, localPath);
  return deleted;
}

Yargs
  .option('token', { alias: 't', default: '' })
  .option('root', { alias: 'r', default: Path.join(process.cwd(), 'repos') })
  .command(
    'create <repo>',
    'create a repository',
    (yargs: Yargs.Argv) => yargs.positional('repo', { describe: 'name of repo' }),
    (argv: Yargs.Arguments) => processCreateCommand(argv)
  )
  .command(
    'delete <repo>',
    'delete a repository',
    (yargs: Yargs.Argv) => yargs.positional('repo', { describe: 'name of repo' }),
    (argv: Yargs.Arguments) => processDeleteCommand(argv)
  )
  .argv;