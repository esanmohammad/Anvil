import { Command } from 'commander';

export const conventionsCommand = new Command('conventions')
  .description('Show or manage conventions for a project')
  .argument('<project>', 'The project to manage conventions for')
  .action(() => {
    process.stderr.write('[ff conventions] Not implemented yet\n');
  });

export const learnCommand = new Command('learn')
  .description('Learn conventions from a project codebase')
  .argument('<project>', 'The project to learn from')
  .action(() => {
    process.stderr.write('[ff learn] Not implemented yet\n');
  });
