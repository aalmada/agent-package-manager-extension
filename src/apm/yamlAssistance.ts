import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';

type ValueType = 'string' | 'boolean' | 'integer' | 'mapping' | 'sequence';
interface Field {
  description: string;
  types?: readonly ValueType[];
  fields?: Record<string, Field>;
  values?: readonly string[];
  strictValues?: boolean;
  items?: Field;
  additional?: Field;
  required?: readonly string[];
}
const string = (description: string, values?: readonly string[]): Field => ({ description, types: ['string'], values, strictValues: !!values });
const boolean = (description: string): Field => ({ description, types: ['boolean'] });
const integer = (description: string): Field => ({ description, types: ['integer'] });
const mapping = (description: string, fields: Record<string, Field> = {}, additional?: Field): Field => ({ description, types: ['mapping'], fields, additional });
const sequence = (description: string, items: Field): Field => ({ description, types: ['sequence'], items });
const strings = (description: string): Field => sequence(description, string('List entry.'));
const stringMap = (description: string): Field => mapping(description, {}, string('String value.'));
const stringOrList = (description: string): Field => ({ ...strings(description), types: ['string', 'sequence'] });
const reference = (description: string, fields: Record<string, Field>, required?: readonly string[]): Field =>
  ({ ...mapping(description, fields), types: ['string', 'mapping'], required });
const any = (description: string): Field => ({ description });
const childField = (field: Field, key: string) =>
  field.fields && Object.hasOwn(field.fields, key) ? field.fields[key] : field.additional;

// Local working-draft hints, not an OpenAPM contract. Unknown fields stay open.
// Sources: microsoft/apm v0.35.0 manifest-schema.md and deps/lockfile.py.
function manifestDefinition(targets: readonly string[]): Field {
  const target: Field = { ...string('Deployment harness. Omit the field for automatic target resolution.', targets), strictValues: false };
  const targetsField: Field = { ...stringOrList(target.description), values: targets, items: target };
  const identity = {
    name: string('Package identifier.'), version: string('Package version.'),
    description: string('Short package description.'), author: string('Package author.'), license: string('Declared package license.')
  };
  const server = {
    name: string('Server identifier.'), command: string('Server executable; put arguments in args.'),
    args: strings('Command-line arguments.'), env: stringMap('Environment overrides; prefer variable references over secrets.')
  };
  const dependency = reference('Package reference or source coordinates.', {
    git: string('Repository URL or shorthand.'), path: string('Local path, or a subpath when git is present.'),
    ref: string('Git branch, tag, commit, or version constraint.'), alias: string('Installation directory name.'),
    type: string('Repository host type.'), allow_insecure: boolean('Allow HTTP; CLI opt-in is still required.'),
    skills: strings('Selected skill names.'), targets: sequence('Restrict deployment to these targets.', target),
    name: string('Marketplace plugin name.'), marketplace: string('Registered marketplace name.'),
    id: string('Registry package identity.'), registry: string('Named registry.'), version: string('Registry or marketplace version constraint.')
  });
  const mcp = reference('MCP registry reference or server configuration.', {
    ...server, transport: string('MCP transport.', ['stdio', 'sse', 'http', 'streamable-http']),
    registry: { description: 'Registry URL, true for the public registry, or false for a self-defined server.', types: ['string', 'boolean'] },
    args: { ...strings('Positional arguments or registry overlay variables.'), types: ['sequence', 'mapping'] },
    version: string('Server version.'), package: string('Package manager.', ['npm', 'pypi', 'oci']),
    url: string('Remote server endpoint.'), headers: stringMap('HTTP headers; prefer variable references over secrets.'),
    tools: strings('Exposed tool names.'), enabled: any('OpenCode-specific value, passed through unchanged.')
  }, ['name']);
  const lsp = reference('LSP server name or configuration.', {
    ...server, transport: string('LSP transport.', ['stdio', 'socket']),
    extensionToLanguage: stringMap('File extensions mapped to language identifiers.'),
    initializationOptions: any('Server initialization options.'), settings: any('Server-specific settings.'),
    workspaceFolder: string('Server workspace folder.'), startupTimeout: integer('Startup timeout in milliseconds.'),
    shutdownTimeout: integer('Shutdown timeout in milliseconds.'), restartOnCrash: boolean('Restart after a crash.'),
    maxRestarts: integer('Maximum restart attempts.')
  });
  const dependencies = mapping('Dependencies installed by APM.', {
    apm: sequence('Agent packages.', dependency), mcp: sequence('MCP servers.', mcp), lsp: sequence('Language servers.', lsp)
  });
  return {
    ...mapping('APM manifest.', {
      ...identity,
      '$schema': string('Explicit contract identity. Omit to use the CLI working draft; do not select a schema just for completion.'),
      target: targetsField, targets: targetsField,
      type: string('Package content type.', ['instructions', 'skill', 'hybrid', 'prompts']),
      dependencies, devDependencies: { ...dependencies, description: 'Development-only dependencies.' },
      scripts: stringMap('Named commands. Execution is explicit and requires APM experimental script support.'),
      includes: { ...stringOrList('Local content to publish. auto selects the authoritative source layout.'), values: ['auto'] },
      compilation: mapping('Context compilation options.', {
        target, strategy: string('Output layout.', ['distributed', 'single-file']), single_file: boolean('Legacy single-file strategy.'),
        output: string('Compiled output path.'), chatmode: string('Chatmode filter.'), resolve_links: boolean('Resolve relative Markdown links.'),
        source_attribution: boolean('Include source and generated-by annotations.'), exclude: stringOrList('Excluded paths or glob patterns.'),
        placement: mapping('Placement tuning.', { min_instructions_per_file: integer('Minimum instructions per output file.') }),
        agents_md: mapping('AGENTS.md output tuning.', {
          mode: string('Replace generated files or maintain a delimited section.', ['full', 'managed_section']),
          start_marker: string('Opening managed-section marker.'), end_marker: string('Closing managed-section marker.')
        })
      }),
      registries: mapping('Named registries and the working-draft default selector.'),
      policy: mapping('Consumer-side policy controls.'),
      allowExecutables: mapping('Per-package executable approvals.', {}, mapping('Executable approvals.', {}, boolean('Approve this executable type.'))),
      lifecycle: mapping('Lifecycle script definitions. Running or trusting scripts requires explicit approval.'),
      replace: sequence('Root-only dependency replacement rules; contract and CLI support are required.', mapping('Replacement rule.')),
      marketplace: mapping('Marketplace authoring metadata.', {
        ...identity, sourceBase: string('HTTPS base for relative package sources.'), output: string('Marketplace output path.'),
        owner: mapping('Publisher identity.', { name: string('Publisher name.'), email: string('Contact email.'), url: string('Publisher homepage.') }),
        metadata: mapping('Free-form marketplace metadata.'), build: mapping('Package reference resolution.', { tagPattern: string('Git tag pattern containing {version}.') }),
        packages: sequence('Published packages.', mapping('Marketplace package.', {
          ...identity, source: string('Repository or local source.'), subdir: string('Repository subdirectory.'),
          ref: string('Explicit Git reference.'), tag_pattern: string('Per-package tag pattern.'),
          include_prerelease: boolean('Include prerelease tags.'), homepage: string('Package homepage.'),
          tags: strings('Package tags.'), keywords: strings('Additional package tags.'), repository: string('Repository URL.'),
          author: reference('Package author.', { name: string('Author name.'), email: string('Contact email.'), url: string('Author homepage.') }),
          category: string('Marketplace category.')
        }))
      })
    }),
    required: ['name', 'version']
  };
}

function lockDefinition(): Field {
  const dependency = mapping('Resolved dependency. Edits can affect reproducibility and deployment ownership.', {
    ...Object.fromEntries(Object.entries({
      repo_url: 'Canonical package source.', materialization_repo_url: 'Source spelling used to materialize the package.',
      name: 'Package-declared display name.', alias: 'Installation directory name.', host: 'Repository host.', host_type: 'Host provider type.',
      registry_prefix: 'Registry path prefix.', resolved_commit: 'Exact resolved Git commit.', resolved_ref: 'Resolved Git reference.',
      version: 'Resolved package version.', virtual_path: 'Path within the repository.', resolved_by: 'Declaring package identity.',
      package_type: 'Resolved package kind.', source: 'Source kind, such as local or registry.', local_path: 'Original local source path.',
      declaring_parent: 'Declaring parent package.', anchored_local_path: 'Anchored local path.', content_hash: 'Local content digest.',
      discovered_via: 'Marketplace provenance.', marketplace_plugin_name: 'Marketplace plugin name.', source_url: 'Marketplace source URL.',
      source_digest: 'Marketplace manifest digest.', resolved_url: 'Registry artifact URL.', resolved_hash: 'Registry artifact digest.',
      constraint: 'Original version constraint.', resolved_tag: 'Resolved Git tag.', resolved_at: 'Resolution timestamp.',
      declared_license: 'Package-declared license.', exec_status: 'Recorded executable trust state.'
    }).map(([name, description]) => [name, string(description)])),
    port: integer('Non-standard repository port.'), depth: integer('Dependency depth.'),
    is_virtual: boolean('Whether this is a repository subpath.'), is_dev: boolean('Development-only dependency.'),
    is_insecure: boolean('Source used HTTP.'), allow_insecure: boolean('HTTP was explicitly approved.'),
    deployed_files: strings('Deployed file paths.'), deployed_file_hashes: stringMap('Deployed file digests.'),
    skill_subset: strings('Selected skills.'), target_subset: strings('Selected deployment targets.'),
    extensions: mapping('Package vendor extensions.'), replacement: mapping('Recorded replacement binding.')
  });
  return mapping('APM lockfile. APM generates this file; it may also be edited manually.', {
    '$schema': string('Explicit lockfile contract identity.'), lockfile_version: string('Lockfile format version.'),
    generated_at: string('Generation timestamp.'), apm_version: string('APM version that wrote the lockfile.'),
    dependencies: sequence('Resolved package dependencies.', dependency),
    deployments: sequence('Deployment ownership ledger.', mapping('Deployment record.')),
    mcp_servers: strings('Installed MCP server names.'), mcp_configs: mapping('Recorded MCP configurations.'),
    mcp_target_servers: mapping('MCP server names per target.', {}, strings('Server names.')),
    mcp_config_provenance: mapping('Declaring packages per MCP server.', {}, stringOrList('Declaring package identities.')),
    mcp_omissions: mapping('Recorded MCP omissions.'), lsp_servers: strings('Installed language server names.'),
    lsp_configs: mapping('Recorded LSP configurations.'),
    lsp_target_servers: mapping('Language server names per target.', {}, strings('Server names.')),
    lsp_config_provenance: stringMap('Declaring package per language server.'),
    local_deployed_files: strings('Files deployed from the root project.'),
    local_deployed_file_hashes: stringMap('Root project deployment digests.'),
    replacements: sequence('Normalized root replacement rules.', mapping('Replacement rule.'))
  });
}

export function yamlDefinition(lockfile: boolean, targets: readonly string[] = []): Field {
  return lockfile ? lockDefinition() : manifestDefinition(targets);
}

export interface LocalIssue { start: number; end: number; message: string }
export function yamlIssues(document: ReturnType<typeof parseDocument>, definition: Field): LocalIssue[] {
  const issues: LocalIssue[] = [];
  const report = (node: unknown, message: string, anchor?: unknown) => {
    const nodeRange = isNode(node) ? node.range : undefined;
    const range = nodeRange && nodeRange[1] > nodeRange[0] ? nodeRange : isNode(anchor) ? anchor.range : nodeRange;
    issues.push({ start: range?.[0] ?? 0, end: range?.[1] ?? 0, message });
  };
  const check = (node: unknown, field: Field, path: string, depth: number, anchor?: unknown) => {
    if (depth > 64 || isAlias(node)) return;
    const type = isMap(node) ? 'mapping' : isSeq(node) ? 'sequence' : isScalar(node)
      ? typeof node.value === 'string' ? 'string' : typeof node.value === 'boolean' ? 'boolean'
        : Number.isInteger(node.value) ? 'integer' : undefined : undefined;
    if (field.types && (!type || !field.types.includes(type))) {
      report(node, `${path} must be ${field.types.join(' or ')}.`, anchor);
      return;
    }
    if (isScalar(node) && typeof node.value === 'string' && field.strictValues && !field.values?.includes(node.value)) {
      report(node, `${path} must be one of: ${field.values?.join(', ')}.`);
    }
    if (isMap(node)) {
      for (const required of field.required ?? []) {
        if (!node.has(required)) report(isScalar(anchor) ? anchor : node.items[0]?.key ?? node, `${path} requires ${required}.`);
      }
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
        const key = pair.key.value, child = childField(field, key);
        if (child) check(pair.value, child, `${path}.${key}`, depth + 1, pair.key);
      }
    } else if (isSeq(node) && field.items) {
      const itemField = field.items;
      node.items.forEach((item, index) => check(item, itemField, `${path}[${index}]`, depth + 1, node));
    }
  };
  check(document.contents, definition, 'APM', 0);
  return issues;
}

interface CompletionContext { field: Field; keys?: string[]; start: number; end: number; hasColon?: boolean }
export function yamlCompletion(text: string, offset: number, definition: Field): CompletionContext | undefined {
  const scalarRange = (range: readonly number[]) => {
    const start = range[0], end = range[1];
    const quote = text[start];
    return quote === '"' || quote === "'"
      ? { start: start + 1, end: end > start + 1 && text[end - 1] === quote ? end - 1 : end }
      : { start, end };
  };
  const existing = (node: unknown, field: Field, depth: number): CompletionContext | undefined => {
    if (depth > 64) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
        const keyRange = pair.key.range;
        if (keyRange && offset >= keyRange[0] && offset <= keyRange[1]) {
          return {
            field, keys: node.items.flatMap(other => other !== pair && isScalar(other.key) ? [String(other.key.value)] : []),
            ...scalarRange(keyRange), hasColon: /^\s*:/.test(text.slice(keyRange[1]))
          };
        }
        const child = childField(field, pair.key.value);
        const result = child && existing(pair.value, child, depth + 1);
        if (result) return result;
      }
    } else if (isSeq(node) && field.items) {
      for (const item of node.items) {
        const result = existing(item, field.items, depth + 1);
        if (result) return result;
      }
    } else if (isScalar(node) && node.range && (field.values || field.types?.includes('boolean'))
      && offset >= node.range[0] && offset <= node.range[1] && node.type !== 'BLOCK_LITERAL' && node.type !== 'BLOCK_FOLDED') {
      return { field, ...scalarRange(node.range) };
    }
  };
  const current = existing(parseDocument(text).contents, definition, 0);
  if (current) return current;
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  const key = /(?:^|[{,])(\s*(?:-\s+)?)([$\w-]*)$/.exec(before);
  const value = /[\w.-]*$/.exec(before)!;
  const start = key ? offset - key[2].length : offset - value[0].length;
  const end = offset + (/^[\w$.-]*/.exec(text.slice(offset))?.[0].length ?? 0);
  const marker = '__apm_editor_completion__';
  const lineEnd = text.indexOf('\n', offset);
  // Parse an unsaved key as a mapping entry, so indentation, sequences and
  // indentless YAML lists are handled by the parser rather than line heuristics.
  const edited = key
    ? text.slice(0, start) + `${marker}: null` + text.slice(key[0].includes('{') || key[0].includes(',') ? end : lineEnd < 0 ? text.length : lineEnd)
    : text.slice(0, start) + marker + text.slice(end);
  const document = parseDocument(edited);
  let result: CompletionContext | undefined;
  const find = (node: unknown, field: Field, depth: number) => {
    if (depth > 64) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
        if (pair.key.value === marker) {
          result = { field, keys: field.fields ? node.items.flatMap(pair => isScalar(pair.key) ? [String(pair.key.value)] : []) : undefined, start, end };
          return;
        }
        const child = childField(field, pair.key.value);
        if (child) find(pair.value, child, depth + 1);
      }
    } else if (isSeq(node) && field.items) {
      for (const item of node.items) find(item, field.items, depth + 1);
    } else if (isScalar(node) && node.value === marker) {
      result = { field, start, end };
    }
  };
  find(document.contents, definition, 0);
  return result;
}

export function yamlHover(document: ReturnType<typeof parseDocument>, offset: number, definition: Field): { field: Field; start: number; end: number } | undefined {
  const find = (node: unknown, field: Field, depth: number): ReturnType<typeof yamlHover> => {
    if (depth > 64) return;
    if (isMap(node)) {
      for (const pair of node.items) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') continue;
        const child = childField(field, pair.key.value);
        if (!child) continue;
        const range = pair.key.range;
        if (range && offset >= range[0] && offset < range[1]) return { field: child, start: range[0], end: range[1] };
        const nested = find(pair.value, child, depth + 1);
        if (nested) return nested;
      }
    } else if (isSeq(node) && field.items) {
      for (const item of node.items) {
        const nested = find(item, field.items, depth + 1);
        if (nested) return nested;
      }
    }
  };
  return find(document.contents, definition, 0);
}
