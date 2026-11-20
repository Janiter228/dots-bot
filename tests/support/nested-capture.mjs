const inner = [[4, 3], [3, 4], [5, 4], [4, 5]];
const outer = [[3, 2], [5, 2], [2, 3], [6, 3], [1, 4], [7, 4],
  [2, 5], [6, 5], [3, 6], [5, 6], [4, 7]];

export const closingMove = [4, 1];

export const nestedPosition = {
  gameId: 'nested-capture',
  moveNo: 17,
  you: 'red',
  field: { width: 9, height: 9 },
  points: { red: [[4, 4], ...outer], blue: inner },
  dead: { red: [[4, 4]], blue: [] },
  score: { red: 0, blue: 1 },
  last: null,
  moveTimeoutMs: 5000,
  timeLeftMs: 900000,
};

export function nestedBoard() {
  const owners = new Uint8Array(81);
  for (const [x, y] of nestedPosition.points.red) owners[y * 9 + x] = 1;
  for (const [x, y] of nestedPosition.points.blue) owners[y * 9 + x] = 2;
  const live = owners.slice();
  live[4 * 9 + 4] = 0;
  return { owners, live };
}
