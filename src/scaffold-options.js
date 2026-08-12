export const scaffoldOptionNames = Object.freeze([
  'theme',
  'layout',
  'palette',
  'typography',
  'spacing',
  'radius',
  'density',
  'motion',
  'componentStyle'
]);

const singleValueOptions = Object.freeze({
  'site-name': 'siteName',
  author: 'siteAuthor',
  language: 'defaultLanguage',
  timezone: 'timezone'
});

function requireValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for --${name}`);
  }
  return value;
}

export function parseScaffoldOptions(args) {
  const values = {};

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument.startsWith('--')) continue;

    const name = argument.slice(2);
    if (name === 'share-target') {
      const value = requireValue(args, index, name);
      values.shareTargets = [...(values.shareTargets ?? []), value];
      index += 1;
      continue;
    }
    if (name === 'social-profile') {
      const value = requireValue(args, index, name);
      values.socialProfiles = [...(values.socialProfiles ?? []), value];
      index += 1;
      continue;
    }

    const targetName = singleValueOptions[name] ?? name;
    if (!scaffoldOptionNames.includes(name) && singleValueOptions[name] == null) continue;

    const value = requireValue(args, index, name);
    values[targetName] = value;
    index += 1;
  }

  return values;
}
