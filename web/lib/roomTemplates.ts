/** Starting points for a new room: a goal to edit, and hints in the instructions, which stay empty so a hint is never sent to an agent as an instruction. */
export const ROOM_TEMPLATES = [
  {
    id: 'deal',
    label: 'Buy or sell',
    goal: 'Agree on the price and terms of the deal',
    want: 'The price we want, what it includes, and when it should happen',
    redLines: 'The most we pay or the least we accept; terms we will not take',
    share: 'Our timeline and what matters most; not our limit',
  },
  {
    id: 'work',
    label: 'Work terms',
    goal: 'Agree on the role, pay and start date',
    want: 'The pay, hours and start date we are looking for',
    redLines: 'The lowest pay or the terms we would walk away from',
    share: 'What we want from the role; not our lowest number',
  },
  {
    id: 'meeting',
    label: 'Schedule a meeting',
    goal: 'Find a time and place to meet',
    want: 'When we would like to meet, for how long, and where',
    redLines: 'Days or times that are impossible',
    share: 'Which times work; not why the others do not',
  },
  {
    id: 'dispute',
    label: 'Settle a disagreement',
    goal: 'Settle the disagreement in a way both sides accept',
    want: 'The outcome we would be happy with',
    redLines: 'What we will not accept or admit',
    share: 'Our view of what happened; not what we would settle for',
  },
] as const;

export type RoomTemplate = (typeof ROOM_TEMPLATES)[number];
