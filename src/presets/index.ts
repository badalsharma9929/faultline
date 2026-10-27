import { problem, type Preset } from './dsl';
import { AI } from './problems/ai';
import { COMMERCE } from './problems/commerce';
import { COMPANIES } from './problems/companies';
import { DATA } from './problems/data';
import { FOUNDATIONS } from './problems/foundations';
import { LOGISTICS } from './problems/logistics';
import { MEDIA } from './problems/media';
import { PAYMENTS } from './problems/payments';
import { PRODUCTIVITY } from './problems/productivity';
import { SOCIAL } from './problems/social';

export { CATEGORIES, type Category, type Preset, type PresetEdge, type PresetNode } from './dsl';

/** Blank canvas with a generic brief, for designing anything. */
export const SANDBOX: Preset = problem({
  id: 'sandbox', name: 'Create your own', category: 'Foundations', difficulty: 'Beginner',
  statement: 'A blank canvas. Set the traffic on the Users node, build any system and see how it holds up.',
  functional: ['Whatever you are designing'], nonFunctional: ['Pick your own load and latency target'],
  rps: 1000, latencyTargetMs: 200, nodes: [], flow: '', notes: ['There is no reference design for your own problem.'],
});

export const PRESETS: Preset[] = [
  SANDBOX, ...FOUNDATIONS, ...SOCIAL, ...MEDIA, ...COMMERCE, ...PAYMENTS, ...LOGISTICS, ...PRODUCTIVITY, ...DATA, ...AI, ...COMPANIES,
];
