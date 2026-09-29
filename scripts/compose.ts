import { compose, reportError } from './lib/compose.ts';

try {
  await compose(process.argv.slice(2), { inherit: true });
} catch (error) {
  reportError(error);
}
