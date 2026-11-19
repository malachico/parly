/** `n` and the noun for it: "1 member", "3 members". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
