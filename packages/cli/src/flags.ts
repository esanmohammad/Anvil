import { Command, Option } from 'commander';

export interface GlobalFlags {
  clarify: boolean;
  skipShip: boolean;
  answers?: string;
}

export function registerGlobalFlags(program: Command): void {
  program
    .addOption(new Option('--no-clarify', 'Skip the clarification stage'))
    .addOption(new Option('--skip-ship', 'Skip the ship stage').default(false))
    .addOption(new Option('--answers <file>', 'Path to pre-answered questions file'));
}
