export type ProjectFile = {
  id: string;
  name: string;
  title: string;
  kind: "xer" | "xlsx" | "pdf" | "docx";
  bytes: number;
  sha256: string;
  pages?: number;
};
export type Activity = {
  id: string;
  projectId: string;
  code: string;
  name: string;
  wbsId: string;
  status: string;
  type: string;
  calendar: string;
  floatHours: number | null;
  originalHours: number | null;
  remainingHours: number | null;
  percent: number | null;
  percentType: string;
  longestPath: boolean;
  dates: Record<string, string>;
  constraints: string[];
  sourceLine: number;
};
export type Wbs = {
  id: string;
  parentId: string;
  code: string;
  name: string;
  order: number;
};
export type Relationship = {
  id: string;
  predecessor: string;
  successor: string;
  type: string;
  lagHours: number | null;
};
export type Schedule = {
  projects: {
    id: string;
    name: string;
    dataDate: string;
    baselineId: string;
  }[];
  exportDate: string;
  activities: Activity[];
  wbs: Wbs[];
  relationships: Relationship[];
  calendarCount: number;
  warnings: string[];
};
export type DateBasis = "schedule" | "planned" | "actual";
