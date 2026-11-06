import contract from './contract.json';
import type { CommandDescriptor, CommandOption } from './types';

export const baseline = contract.version;
export const descriptors: CommandDescriptor[] = contract.commands as CommandDescriptor[];

export function requiresTerminal(descriptor: CommandDescriptor, options: Record<string, unknown>): boolean {
  if (descriptor.id === 'compile' && options['--watch'] === true) return true;
  if (descriptor.id === 'init' || descriptor.id === 'plugin init') {
    return options['--yes'] !== true && options['--discover'] !== true && options['--apply'] !== true;
  }
  return !!descriptor.interactive && (descriptor.id !== 'runtime remove' || options['--yes'] !== true);
}

function optionValues(option: CommandOption, value: unknown): string[] {
  if (value === undefined || value === null || value === '') {
    if (option.required) throw new Error(`${option.name} is required.`);
    return [];
  }
  if (option.optionalValue && value === true) return [option.name];
  if (option.type === 'boolean') {
    if (typeof value !== 'boolean') throw new Error(`${option.name} must be a boolean.`);
    return value ? [option.name] : option.negative ? [option.negative] : [];
  }
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`Invalid ${option.name}.`);
  const raw = String(value);
  const values = option.repeatable ? raw.split('\n').filter(Boolean) : [raw];
  return values.flatMap(entry => {
    if (entry.includes('\0')) throw new Error(`Invalid NUL in ${option.name}.`);
    if (option.type === 'number' && !Number.isFinite(Number(entry))) throw new Error(`${option.name} must be a number.`);
    if (option.choices && !option.choices.some(choice => option.caseSensitive === false ? choice.toLowerCase() === entry.toLowerCase() : choice === entry)) {
      throw new Error(`Unsupported ${option.name} value. Choose ${option.choices.join(', ')}.`);
    }
    const parts = (option.nargs ?? 1) > 1 ? entry.split('\t') : [entry];
    if (parts.length !== (option.nargs ?? 1)) throw new Error(`${option.name} requires ${option.nargs} tab-separated values.`);
    return [option.name, ...parts];
  });
}

export function buildCommandArguments(descriptor: CommandDescriptor, args: Record<string, string>, options: Record<string, unknown>): string[] {
  for (const key of Object.keys(args)) {
    if (!descriptor.positionals.some(a => a.name === key)) throw new Error(`Unknown argument ${key}.`);
  }
  for (const key of Object.keys(options)) {
    if (!descriptor.options.some(o => o.name === key)) throw new Error(`Unknown option ${key}.`);
  }
  const result: string[] = [];
  for (const option of descriptor.options.filter(o => o.at === 0)) result.push(...optionValues(option, options[option.name]));
  for (let depth = 1; depth <= descriptor.command.length; depth++) {
    result.push(descriptor.command[depth - 1]);
    for (const option of descriptor.options.filter(o => (o.at ?? descriptor.command.length) === depth)) {
      result.push(...optionValues(option, options[option.name]));
    }
    let optionalOmitted = false;
    for (const argument of descriptor.positionals.filter(a => (a.at ?? descriptor.command.length) === depth)) {
      const value = args[argument.name] ?? '';
      if (!value) {
        if (argument.required) throw new Error(`${argument.label} is required.`);
        optionalOmitted = true;
        continue;
      }
      if (optionalOmitted) throw new Error(`Cannot supply ${argument.label} after omitting an earlier argument.`);
      const values = argument.variadic ? value.split('\n').filter(Boolean) : [value];
      if (values.some(v => v.startsWith('-') || v.includes('\0'))) throw new Error(`Invalid ${argument.label}: values cannot begin with '-' or contain NUL.`);
      result.push(...values);
    }
  }
  return result;
}
