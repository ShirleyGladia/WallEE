import type { StageId } from './data/types'

// One place that describes the loop. Colors match the sticky notes on the team whiteboard.
export interface StageDef {
  id: StageId
  index: string
  name: string
  path: string
  question: string // the diamond on the whiteboard
  asks: string // the challenge question this stage answers
  color: string // CSS variable name
  short: string // label on the whiteboard view
}

export const STAGES: StageDef[] = [
  {
    id: 'ingest',
    index: '01',
    name: 'Ingest',
    short: 'Ingest',
    path: '/ingest',
    question: 'Is this file valid?',
    asks: 'Turn raw robot demonstrations into reliable training data.',
    color: '--st-ingest',
  },
  {
    id: 'dataset',
    index: '02',
    name: 'Dataset intelligence',
    short: 'Intelligent data',
    path: '/dataset',
    question: 'Is the dataset good as a whole?',
    asks: 'Find invalid, redundant or missing episodes before training.',
    color: '--st-dataset',
  },
  {
    id: 'select',
    index: '03',
    name: 'Select data',
    short: 'Select data',
    path: '/select',
    question: 'Which data do we train on?',
    asks: 'Decide which dataset groups go into training, validation and test, and record who decided and why.',
    color: '--st-select',
  },
  {
    id: 'train',
    index: '04',
    name: 'Train',
    short: 'Train',
    path: '/train',
    question: 'Checks passed — train',
    asks: 'Turn the demonstrations into an adaptable robot capability.',
    color: '--st-train',
  },
  {
    id: 'evaluate',
    index: '05',
    name: 'Evaluate',
    short: 'Evaluate',
    path: '/evaluate',
    question: 'Good enough?',
    asks: 'Measure what the robot learned and where it still fails.',
    color: '--st-evaluate',
  },
  {
    id: 'serve',
    index: '06',
    name: 'Version & serve',
    short: 'Version & serve',
    path: '/serve',
    question: 'Ship it',
    asks: 'Make the capability reproducible and ready to use.',
    color: '--st-serve',
  },
  {
    id: 'diagnose',
    index: '↺',
    name: 'Diagnose',
    short: 'Diagnose',
    path: '/diagnose',
    question: 'What failed? What needs improving?',
    asks: 'Turn evaluation failures into the next cycle’s data and checks.',
    color: '--st-diagnose',
  },
]

export const stageById = (id: StageId) => STAGES.find((s) => s.id === id)!
