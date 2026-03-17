import { useState, useCallback, useMemo } from 'react';

export interface SlashCommand {
  name: string;
  description: string;
  args?: string;
  local: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help',     description: 'Show available commands',                local: true  },
  { name: 'clear',    description: 'Clear conversation history',             local: true  },
  { name: 'continue', description: 'Continue the last response',             local: true  },
  { name: 'compact',  description: 'Compact conversation to save tokens',    local: false, args: '[instructions]' },
  { name: 'cost',     description: 'Show token usage for this session',      local: false },
  { name: 'status',   description: 'Show session information',               local: false },
  { name: 'config',   description: 'Show current backend configuration',     local: false },
  { name: 'model',    description: 'Show or switch current model',           local: true,  args: '[model_name]' },
  { name: 'init',     description: 'Initialize CLAUDE.md in working dir',    local: false },
];

export function useSlashCommands() {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const filtered = useMemo(() => {
    if (!query) return SLASH_COMMANDS;
    return SLASH_COMMANDS.filter((cmd) =>
      cmd.name.toLowerCase().startsWith(query.toLowerCase())
    );
  }, [query]);

  const updateFromInput = useCallback((text: string) => {
    if (text.startsWith('/') && !text.includes('\n')) {
      const parts = text.slice(1).split(' ');
      const q = parts[0] || '';
      setQuery(q);
      setIsOpen(true);
      setSelectedIndex(0);
    } else {
      setIsOpen(false);
      setQuery('');
    }
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setQuery('');
  }, []);

  const moveSelection = useCallback(
    (dir: 'up' | 'down') => {
      setSelectedIndex((prev) => {
        const max = filtered.length - 1;
        if (dir === 'up') return prev <= 0 ? max : prev - 1;
        return prev >= max ? 0 : prev + 1;
      });
    },
    [filtered.length]
  );

  return {
    isOpen,
    filtered,
    selectedIndex,
    setSelectedIndex,
    updateFromInput,
    close,
    moveSelection,
  };
}

export const HELP_TEXT = SLASH_COMMANDS.map(
  (c) => `  /${c.name}${c.args ? ' ' + c.args : ''}  —  ${c.description}`
).join('\n');