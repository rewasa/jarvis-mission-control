export type SlashCommandCategory =
  | 'AgentControl'
  | 'Session'
  | 'Config'
  | 'Tools'
  | 'Info'
  | 'Exit';

export interface SlashCommandDefinition {
  command: string;
  aliases?: string[];
  args?: string;
  description: string;
  category: SlashCommandCategory;
  agentControl?: boolean;
}

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    command: '/steer',
    args: '<instruction>',
    description: 'Inject guidance into a running AgentControl/Kanban-backed task and persist it as Kanban evidence when linked.',
    category: 'AgentControl',
    agentControl: true,
  },
  {
    command: '/queue',
    args: '<message>',
    description: 'Queue a message to send after the current AgentControl response finishes.',
    category: 'AgentControl',
    agentControl: true,
  },
  {
    command: '/goal',
    args: '<goal>',
    description: 'Run the task in goal mode from AgentControl; Shift+Tab toggles goal mode without typing this command.',
    category: 'AgentControl',
    agentControl: true,
  },
  {
    command: '/new',
    aliases: ['/reset'],
    description: 'Start a fresh Hermes session.',
    category: 'Session',
  },
  {
    command: '/clear',
    description: 'Clear the CLI screen and start a new session.',
    category: 'Session',
  },
  {
    command: '/retry',
    description: 'Resend the last message.',
    category: 'Session',
  },
  {
    command: '/undo',
    description: 'Remove the last exchange.',
    category: 'Session',
  },
  {
    command: '/title',
    args: '[name]',
    description: 'Name the Hermes session.',
    category: 'Session',
  },
  {
    command: '/compress',
    description: 'Manually compress the conversation context.',
    category: 'Session',
  },
  {
    command: '/stop',
    description: 'Kill tracked background processes.',
    category: 'Session',
  },
  {
    command: '/rollback',
    args: '[N]',
    description: 'Restore a filesystem checkpoint when checkpoints are enabled.',
    category: 'Session',
  },
  {
    command: '/background',
    args: '<prompt>',
    description: 'Run a prompt in the background.',
    category: 'Session',
  },
  {
    command: '/resume',
    args: '[name]',
    description: 'Resume a named Hermes session.',
    category: 'Session',
  },
  {
    command: '/config',
    description: 'Show Hermes config in CLI sessions.',
    category: 'Config',
  },
  {
    command: '/model',
    args: '[name]',
    description: 'Show or change the active model.',
    category: 'Config',
  },
  {
    command: '/provider',
    description: 'Show provider information.',
    category: 'Config',
  },
  {
    command: '/prompt',
    args: '[text]',
    description: 'View or set the system prompt in CLI sessions.',
    category: 'Config',
  },
  {
    command: '/personality',
    args: '[name]',
    description: 'Set the active personality.',
    category: 'Config',
  },
  {
    command: '/reasoning',
    args: '[none|low|medium|high|xhigh|show|hide]',
    description: 'Set reasoning effort or visibility.',
    category: 'Config',
  },
  {
    command: '/verbose',
    description: 'Cycle verbose output: off, new, all, verbose.',
    category: 'Config',
  },
  {
    command: '/voice',
    args: '[on|off|tts]',
    description: 'Toggle voice mode.',
    category: 'Config',
  },
  {
    command: '/yolo',
    description: 'Toggle approval bypass.',
    category: 'Config',
  },
  {
    command: '/skin',
    args: '[name]',
    description: 'Change the CLI theme.',
    category: 'Config',
  },
  {
    command: '/statusbar',
    description: 'Toggle the CLI status bar.',
    category: 'Config',
  },
  {
    command: '/tools',
    description: 'Manage Hermes tools in CLI sessions.',
    category: 'Tools',
  },
  {
    command: '/toolsets',
    description: 'List enabled toolsets.',
    category: 'Tools',
  },
  {
    command: '/skills',
    description: 'Search or install skills.',
    category: 'Tools',
  },
  {
    command: '/skill',
    args: '<name>',
    description: 'Load a skill into the active session.',
    category: 'Tools',
  },
  {
    command: '/cron',
    description: 'Manage cron jobs.',
    category: 'Tools',
  },
  {
    command: '/reload-mcp',
    description: 'Reload configured MCP servers.',
    category: 'Tools',
  },
  {
    command: '/plugins',
    description: 'List plugins in CLI sessions.',
    category: 'Tools',
  },
  {
    command: '/help',
    description: 'Show command help.',
    category: 'Info',
  },
  {
    command: '/commands',
    args: '[page]',
    description: 'Browse all commands in gateway sessions.',
    category: 'Info',
  },
  {
    command: '/usage',
    description: 'Show token usage.',
    category: 'Info',
  },
  {
    command: '/insights',
    args: '[days]',
    description: 'Show usage analytics.',
    category: 'Info',
  },
  {
    command: '/status',
    description: 'Show session status in gateway sessions.',
    category: 'Info',
  },
  {
    command: '/profile',
    description: 'Show active profile information.',
    category: 'Info',
  },
  {
    command: '/quit',
    aliases: ['/exit', '/q'],
    description: 'Exit the Hermes CLI session.',
    category: 'Exit',
  },
];

export function slashCommandTokens(definition: SlashCommandDefinition): string[] {
  return [definition.command, ...(definition.aliases ?? [])];
}
