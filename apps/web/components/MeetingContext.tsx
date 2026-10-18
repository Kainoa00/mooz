"use client";

import { createContext, useContext } from "react";

export interface MeetingInfo {
  slug: string;
  isHost: boolean;
}

export const MeetingContext = createContext<MeetingInfo>({ slug: "", isHost: false });

export const useMeeting = () => useContext(MeetingContext);
