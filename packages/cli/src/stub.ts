import { Command } from 'commander';

export function createStubCommand(name: string, description: string): Command {
  return new Command(name)
    .description(description)
    .action(() => {
      process.stderr.write(`[ff ${name}] Not implemented yet\n`);
    });
}
