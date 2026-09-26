export const milestoneCodes = ["MS-260", "MS-280"] as const;
export type TargetMilestoneCode = typeof milestoneCodes[number];
export const milestoneOptions = [
  { code: "MS-260", label: "MS-260 · Launching pit excavation and mud slab" },
  { code: "MS-280", label: "MS-280 · Work necessary to launch the TBM" },
] as const;
