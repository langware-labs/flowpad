export interface MockMessage {
  id: string;
  author: string;
  authorColor: string;
  timestamp: string;
  text: string;
}

export const MOCK_MESSAGES: MockMessage[] = [
  {
    id: '1',
    author: 'Sam',
    authorColor: 'bg-purple-500',
    timestamp: '10:04',
    text: 'Hey — pulled you in to take a look at the retry logic in /api/ingest.',
  },
  {
    id: '2',
    author: 'You',
    authorColor: 'bg-emerald-500',
    timestamp: '10:05',
    text: 'Sure, what are you seeing?',
  },
  {
    id: '3',
    author: 'Sam',
    authorColor: 'bg-purple-500',
    timestamp: '10:05',
    text: 'Some 502s under load. I shared the failing shell — take a look at the tab on the right.',
  },
  {
    id: '4',
    author: 'You',
    authorColor: 'bg-emerald-500',
    timestamp: '10:07',
    text: 'On it.',
  },
];
