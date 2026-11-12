import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { record } from '../apm/adapters';
import { readOptional } from '../apm/manifest';
import { repositoryFromPackageSource, type Repository, type RepositoryHost } from './repositories';

/** Read dependency expressions without invoking APM or accessing remote repositories. */
export async function dependencyExpressions(root: string): Promise<string[]> {
  const expressions: string[] = [];
  for (const name of ['apm.yml', 'apm.lock.yaml']) {
    const text = await readOptional(join(root, name));
    if (text === undefined) continue;
    const document: unknown = parseYaml(text);
    if (!record(document)) throw new Error(`Cannot read authentication context from ${name}: expected an object.`);
    const dependencies = document.dependencies;
    const entries = Array.isArray(dependencies) ? dependencies : record(dependencies) && Array.isArray(dependencies.apm) ? dependencies.apm : [];
    for (const value of entries) {
      if (typeof value === 'string') expressions.push(value);
      else if (record(value)) {
        if (value.source === 'local' || (typeof value.repo_url === 'string' && value.repo_url.startsWith('_local/'))) continue;
        if (typeof value.host === 'string' && typeof value.repo_url === 'string') expressions.push(`https://${value.host}/${value.repo_url}`);
        else for (const field of ['git', 'repo', 'repository', 'url', 'repo_url']) {
          if (typeof value[field] === 'string') expressions.push(value[field]);
        }
      }
    }
  }
  return expressions;
}

export async function dependencyRepositories(root: string, hosts: readonly RepositoryHost[]): Promise<Repository[]> {
  return (await dependencyExpressions(root)).map(source => repositoryFromPackageSource(source, hosts))
    .filter((repository): repository is Repository => repository !== undefined);
}
