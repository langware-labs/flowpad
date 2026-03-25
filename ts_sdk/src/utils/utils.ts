export type XMLChunkParserEvent = {
  event: string;
  args: Record<string, string> | null;
  content: string;
  key: string | null; // identifies the tag instance this event belongs to
};

type TagStackEntry = [
  string,
  Record<string, string>,
  string, // key
];

function escapeRegex(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class XMLChunkParser {
  private currentContext: string;
  private currentArgs: Record<string, string> | null;
  private currentKey: string | null;
  private tagStack: TagStackEntry[];
  private tagPrefix: string | null;
  private pendingTag: string;
  private tagPattern: RegExp;

  // simple counter to generate unique keys
  private keyCounter: number;

  constructor(tagPrefix: string | null = null) {
    this.currentContext = 'chat';
    this.currentArgs = null;
    this.currentKey = null;
    this.tagStack = [];
    this.tagPrefix = tagPrefix;
    this.pendingTag = '';
    this.tagPattern = this.buildTagPattern();
    this.keyCounter = 0;
  }

  private buildTagPattern(): RegExp {
    if (this.tagPrefix) {
      const prefixPatterns = [];
      for (let i = 1; i <= this.tagPrefix.length; i++) {
        prefixPatterns.push(escapeRegex(this.tagPrefix.substring(0, i)));
      }
      return new RegExp(`<(?=/|${prefixPatterns.join('|')})`);
    }
    return /<(?=\/|\w)/;
  }

  private nextKey(): string {
    // You can change the format if you want tag-aware keys
    this.keyCounter += 1;
    return `k${this.keyCounter}`;
  }

  processChunk(chunk: string): XMLChunkParserEvent[] {
    const events: XMLChunkParserEvent[] = [];
    const textToProcess = this.pendingTag + chunk;
    this.pendingTag = '';

    let currentPos = 0;
    while (currentPos < textToProcess.length) {
      const tagStartMatch = this.tagPattern.exec(textToProcess.substring(currentPos));

      if (!tagStartMatch) {
        // No more tags in the remaining text
        const content = textToProcess.substring(currentPos);
        if (content) {
          events.push({
            event: this.currentContext,
            args: this.currentArgs,
            content: content,
            key: this.currentKey,
          });
        }
        break;
      }

      const tagStartOffset = currentPos + tagStartMatch.index;

      if (tagStartOffset > currentPos) {
        const content = textToProcess.substring(currentPos, tagStartOffset);
        events.push({
          event: this.currentContext,
          args: this.currentArgs,
          content: content,
          key: this.currentKey,
        });
      }

      const tagEndOffset = textToProcess.indexOf('>', tagStartOffset);

      if (tagEndOffset === -1) {
        this.pendingTag = textToProcess.substring(tagStartOffset);
        break;
      }

      const tagStr = textToProcess.substring(tagStartOffset, tagEndOffset + 1);
      const tagProcessingEvents = this._processTagString(tagStr);
      events.push(...tagProcessingEvents);

      currentPos = tagEndOffset + 1;
    }

    return events;
  }

  private _processTagString(tagStr: string): XMLChunkParserEvent[] {
    const generatedEvents: XMLChunkParserEvent[] = [];

    const isClosingTag = tagStr.startsWith('</');
    const isSelfClosingTag = tagStr.endsWith('/>');

    let tagNameMatch: RegExpMatchArray | null;
    if (isClosingTag) {
      tagNameMatch = tagStr.match(/<\/([^>\s]+)/);
    } else {
      tagNameMatch = tagStr.match(/<([^>\s/]+)/);
    }

    if (!tagNameMatch) {
      generatedEvents.push({
        event: this.currentContext,
        args: this.currentArgs,
        content: tagStr,
        key: this.currentKey,
      });
      return generatedEvents;
    }

    const tagName = tagNameMatch[1];

    if (this.tagPrefix && !tagName.startsWith(this.tagPrefix)) {
      generatedEvents.push({
        event: this.currentContext,
        args: this.currentArgs,
        content: tagStr,
        key: this.currentKey,
      });
      return generatedEvents;
    }

    if (isClosingTag) {
      if (this.tagStack.length > 0 && this.tagStack[this.tagStack.length - 1][0] === tagName) {
        // Pop and restore parent context/key
        this.tagStack.pop();
        if (this.tagStack.length > 0) {
          const [parentName, parentArgs, parentKey] = this.tagStack[this.tagStack.length - 1];
          this.currentContext = parentName;
          this.currentArgs = parentArgs;
          this.currentKey = parentKey;
        } else {
          this.currentContext = 'chat';
          this.currentArgs = null;
          this.currentKey = null;
        }
        // Emit a boundary event if you want to signal the context change
        generatedEvents.push({
          event: this.currentContext,
          args: this.currentArgs,
          content: '',
          key: this.currentKey,
        });
      } else {
        // Unmatched closing tag -> treat as text
        generatedEvents.push({
          event: this.currentContext,
          args: this.currentArgs,
          content: tagStr,
          key: this.currentKey,
        });
      }
    } else if (isSelfClosingTag) {
      const attrs: Record<string, string> = {};
      const attrMatches = tagStr.matchAll(/([a-zA-Z0-9_-]+)=(['"])(.*?)\2/g);
      for (const match of attrMatches) {
        attrs[match[1]] = match[3];
      }
      const key = this.nextKey();
      generatedEvents.push({
        event: tagName,
        args: attrs,
        content: '',
        key,
      });
      // Note: no context change for self-closing tags
    } else {
      const attrs: Record<string, string> = {};
      const attrMatches = tagStr.matchAll(/([a-zA-Z0-9_-]+)=(['"])(.*?)\2/g);
      for (const match of attrMatches) {
        attrs[match[1]] = match[3];
      }

      // New tag context and key
      const key = this.nextKey();
      this.tagStack.push([tagName, attrs, key]);
      this.currentContext = tagName;
      this.currentArgs = attrs;
      this.currentKey = key;

      generatedEvents.push({
        event: this.currentContext,
        args: this.currentArgs,
        content: '',
        key: this.currentKey,
      });
    }
    return generatedEvents;
  }

  reset(): void {
    this.currentContext = 'chat';
    this.currentArgs = null;
    this.currentKey = null;
    this.tagStack = [];
    this.pendingTag = '';
    this.keyCounter = 0;
  }
}

export function processXml(xmlContent: string, tagPrefix: string | null = null): XMLChunkParserEvent[] {
  const parser = new XMLChunkParser(tagPrefix);
  const events = parser.processChunk(xmlContent);
  const merged = new Map<string, XMLChunkParserEvent>();
  const order: (XMLChunkParserEvent | string)[] = [];

  for (const e of events) {
    if (e.key === null) {
      // Root events: do not aggregate, push directly
      order.push(e);
      continue;
    }
    if (!merged.has(e.key)) {
      merged.set(e.key, {
        event: e.event,
        args: e.args ? { ...e.args } : null,
        content: e.content,
        key: e.key,
      });
      order.push(e.key);
    } else {
      merged.get(e.key)!.content += e.content;
    }
  }

  return order
    .map((item) => (typeof item === 'string' ? merged.get(item)! : item))
    .filter((ev) => ev.content.trim() || Object.keys(ev.args || {}).length !== 0);
}

export const detectLanguage = (path: string) => {
  const extension = path.split('.').pop()?.toLowerCase();

  if (!extension) return 'plaintext';

  // Web Technologies
  if (extension === 'js' || extension === 'mjs') return 'javascript';
  if (extension === 'ts') return 'typescript';
  if (extension === 'tsx') return 'tsx';
  if (extension === 'jsx') return 'javascript';
  if (extension === 'html' || extension === 'htm') return 'html';
  if (extension === 'css') return 'css';
  if (extension === 'scss') return 'scss';
  if (extension === 'sass') return 'sass';
  if (extension === 'less') return 'less';
  if (extension === 'json') return 'json';
  if (extension === 'xml') return 'xml';

  // System Programming
  if (extension === 'c') return 'c';
  if (
    extension === 'cpp' ||
    extension === 'cc' ||
    extension === 'cxx' ||
    extension === 'c++' ||
    extension === 'hpp' ||
    extension === 'h'
  )
    return 'cpp';
  if (extension === 'rs') return 'rust';
  if (extension === 'go') return 'go';
  if (extension === 'swift') return 'swift';
  if (extension === 'm' || extension === 'mm') return 'objective-c';

  // JVM Ecosystem
  if (extension === 'java') return 'java';
  if (extension === 'scala' || extension === 'sc') return 'scala';
  if (extension === 'kt' || extension === 'kts') return 'kotlin';
  if (extension === 'clj' || extension === 'cljs' || extension === 'cljc') return 'clojure';

  // .NET Languages
  if (extension === 'cs') return 'csharp';
  if (extension === 'fs' || extension === 'fsx' || extension === 'fsi') return 'fsharp';
  if (extension === 'vb') return 'vb';

  // Scripting & Dynamic
  if (extension === 'py' || extension === 'pyw' || extension === 'pyi') return 'python';
  if (extension === 'rb') return 'ruby';
  if (extension === 'php' || extension === 'phtml') return 'php';
  if (extension === 'pl' || extension === 'pm') return 'perl';
  if (extension === 'lua') return 'lua';

  // Functional Languages
  if (extension === 'hs' || extension === 'lhs') return 'haskell';
  if (extension === 'scm' || extension === 'ss') return 'scheme';
  if (extension === 'r' || extension === 'rdata' || extension === 'rds') return 'r';

  // Data & Config
  if (extension === 'sql') return 'sql';
  if (extension === 'yaml' || extension === 'yml') return 'yaml';
  if (extension === 'toml') return 'ini'; // Monaco uses 'ini' for TOML-like syntax
  if (extension === 'dockerfile') return 'dockerfile';
  if (path.toLowerCase().includes('dockerfile')) return 'dockerfile';

  // Shell & Scripting
  if (extension === 'sh' || extension === 'bash' || extension === 'zsh' || extension === 'profile') return 'shell';
  if (extension.toLowerCase().startsWith('bash')) return 'shell';
  if (extension === 'ps1' || extension === 'psm1' || extension === 'psd1') return 'powershell';
  if (extension === 'bat' || extension === 'cmd') return 'bat';

  // Other Notable Languages
  if (extension === 'md' || extension === 'markdown' || extension === 'mdo') return 'markdown';
  if (extension === 'graphql' || extension === 'gql') return 'graphql';
  if (extension === 'sparql') return 'sparql';
  // if (extension === 'redis') return 'redis'; Not supported by shiki

  // Additional common formats
  if (extension === 'ini' || extension === 'cfg' || extension === 'conf') return 'ini';
  if (extension === 'log') return 'log';
  if (extension === 'txt') return 'plaintext';

  return 'plaintext';
};

export type EditorLanguage = ReturnType<typeof detectLanguage>;

export const downloadFile = (file: { name: string; content: Blob }) => {
  const url = URL.createObjectURL(file.content);
  const a = document.createElement('a');
  a.href = url;
  console.log('downloading file', file.name);
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
};

export const downloadFileFromUrl = (url: string) => {
  const a = document.createElement('a');
  a.href = url;
  a.download = url;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
  }, 0);
};

export const copyToClipboard = async (content: string) => {
  try {
    await navigator.clipboard.writeText(content);
  } catch {
    // fallback or error handling
    // Import alert from the SDK alert module dynamically to avoid circular dependencies
    const { alert } = await import('../alert');
    alert('Copy Failed', 'Failed to copy to clipboard', 'danger');
  }
};

export const timeAgo = (isoDate: Date): string => {
  const now = new Date();
  const past = new Date(isoDate);
  const diff = Math.floor((now.getTime() - past.getTime()) / 1000); // in seconds

  const units = [
    { name: 'year', seconds: 60 * 60 * 24 * 365 },
    { name: 'month', seconds: 60 * 60 * 24 * 30 },
    { name: 'week', seconds: 60 * 60 * 24 * 7 },
    { name: 'day', seconds: 60 * 60 * 24 },
    { name: 'hour', seconds: 60 * 60 },
    { name: 'minute', seconds: 60 },
    { name: 'second', seconds: 1 },
  ];

  for (const unit of units) {
    const value = Math.floor(diff / unit.seconds);
    if (value > 0) {
      return `${value} ${unit.name}${value > 1 ? 's' : ''} ago`;
    }
  }

  return 'just now';
};
