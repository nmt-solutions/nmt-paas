type ParsedEnvVar = {
  key: string;
  value: string;
};

type ParseResult =
  | {
      type: "single";
      data: ParsedEnvVar;
    }
  | {
      type: "multiple";
      data: ParsedEnvVar[];
    };

function stripInlineComment(value: string) {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < value.length; i++) {
    const char = value[i];

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Remove comments only outside quotes
    if (char === "#" && !inSingleQuote && !inDoubleQuote) {
      return value.slice(0, i).trimEnd();
    }
  }

  return value.trimEnd();
}

export function parseEnvFile(content: string): ParsedEnvVar[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  const result: ParsedEnvVar[] = [];

  let currentKey: string | null = null;
  let currentValueLines: string[] = [];
  let multilineQuote: '"' | "'" | null = null;

  const pushCurrent = () => {
    if (!currentKey) return;

    result.push({
      key: currentKey,
      value: currentValueLines.join("\n"),
    });

    currentKey = null;
    currentValueLines = [];
    multilineQuote = null;
  };

  for (const rawLine of lines) {
    const line = rawLine;

    // Ignore empty lines outside multiline
    if (!currentKey && !line.trim()) continue;

    // Ignore full-line comments
    if (!currentKey && line.trim().startsWith("#")) continue;

    // Start parsing new env
    if (!currentKey) {
      const equalIndex = line.indexOf("=");

      if (equalIndex === -1) continue;

      const key = line.slice(0, equalIndex).trim();

      let value = line.slice(equalIndex + 1).trim();

      // Remove inline comments
      value = stripInlineComment(value);

      const startsWithQuote = value.startsWith('"') || value.startsWith("'");

      const quoteChar = value[0] as '"' | "'" | undefined;

      // Multiline start
      if (startsWithQuote && quoteChar && !value.endsWith(quoteChar)) {
        currentKey = key;
        multilineQuote = quoteChar;
        currentValueLines.push(value.slice(1));
        continue;
      }

      // Single line quoted
      if (startsWithQuote && quoteChar && value.endsWith(quoteChar)) {
        value = value.slice(1, -1);
      }

      result.push({
        key,
        value,
      });

      continue;
    }

    // Multiline continuation
    const isLastLine = multilineQuote !== null && line.endsWith(multilineQuote);

    if (isLastLine) {
      currentValueLines.push(line.slice(0, -1));
      pushCurrent();
    } else {
      currentValueLines.push(line);
    }
  }

  pushCurrent();

  return result;
}

/**
 * Detects whether pasted content is:
 * - single env entry
 * - or full env file
 */
export function parseEnvInput(input: string): ParseResult {
  const trimmed = input.trim();

  const parsed = parseEnvFile(trimmed);

  // Raw value only
  if (parsed.length === 0) {
    return {
      type: "single",
      data: {
        key: "",
        value: trimmed,
      },
    };
  }

  // Single env variable
  if (parsed.length === 1) {
    const first = parsed[0];

    const withoutFirstLine = trimmed.replace(trimmed.split("\n")[0] ?? "", "");

    const otherEnvKeysExist = /^[A-Za-z0-9_.-]+\s*=/gm.test(withoutFirstLine);

    if (!otherEnvKeysExist && first) {
      return {
        type: "single",
        data: first,
      };
    }
  }

  // Full env file
  return {
    type: "multiple",
    data: parsed,
  };
}
