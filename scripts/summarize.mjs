import { summarizeDirectory, summarizeFile } from "./summary-lib.mjs";

function usage() {
  return [
    "Usage:",
    "  npm run summarize -- <context-profiler.ndjson>",
    "  npm run summarize -- --dir <log-directory> [options]",
    "",
    "Batch options:",
    "  --since <ISO timestamp>       Include sessions started at or after this time",
    "  --until <ISO timestamp>       Include sessions started at or before this time",
    "  --min-requests <count>        Minimum provider requests per session (default: 1)",
    "  --package-version <version>   Include only logs written by this profiler version",
    "  --top <count>                 Maximum ranked items per section (default: 20)",
    "  --help                        Show this help",
  ].join("\n");
}

function positiveInteger(flag, value, allowZero = false) {
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${flag} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function parseArguments(args) {
  const options = {
    file: undefined,
    directory: undefined,
    since: undefined,
    until: undefined,
    minimumProviderRequests: 1,
    packageVersion: undefined,
    top: 20,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }
    if (argument === "--dir") {
      options.directory = args[++index];
      if (!options.directory) throw new Error("--dir requires a path");
      continue;
    }
    if (argument === "--since" || argument === "--until") {
      const value = args[++index];
      if (!value) throw new Error(`${argument} requires a timestamp`);
      options[argument === "--since" ? "since" : "until"] = value;
      continue;
    }
    if (argument === "--min-requests") {
      options.minimumProviderRequests = positiveInteger(argument, args[++index], true);
      continue;
    }
    if (argument === "--package-version") {
      options.packageVersion = args[++index];
      if (!options.packageVersion) throw new Error("--package-version requires a value");
      continue;
    }
    if (argument === "--top") {
      options.top = positiveInteger(argument, args[++index]);
      if (options.top > 100) throw new Error("--top must be <= 100");
      continue;
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`);
    if (options.file) throw new Error("Only one NDJSON file may be summarized at a time");
    options.file = argument;
  }

  if (options.file && options.directory) {
    throw new Error("Choose either a single NDJSON file or --dir, not both");
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.file && !options.directory) {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 1;
    return;
  }

  const result = options.directory
    ? await summarizeDirectory(options.directory, options)
    : await summarizeFile(options.file, { detailed: true, top: options.top });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
