"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type ArtifactKind = "text" | "code" | "image" | "sheet";

export type UIArtifact = {
  documentId: string;
  content: string;
  kind: ArtifactKind;
  title: string;
  status: "streaming" | "idle" | "failed";
  isVisible: boolean;
  boundingBox: {
    top: number;
    left: number;
    width: number;
    height: number;
  };
};

export const initialArtifactData: UIArtifact = {
  documentId: "init",
  content: "",
  kind: "text",
  title: "Artifacts",
  status: "idle",
  isVisible: false,
  boundingBox: {
    top: 0,
    left: 0,
    width: 0,
    height: 0,
  },
};

type ArtifactContextValue = {
  artifact: UIArtifact;
  setArtifact: (
    updater: UIArtifact | ((currentArtifact: UIArtifact) => UIArtifact)
  ) => void;
};

const ArtifactContext = createContext<ArtifactContextValue | null>(null);

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [artifact, setArtifactState] =
    useState<UIArtifact>(initialArtifactData);

  const setArtifact = useCallback<ArtifactContextValue["setArtifact"]>(
    (updater) => {
      setArtifactState((currentArtifact) =>
        typeof updater === "function" ? updater(currentArtifact) : updater
      );
    },
    []
  );

  const value = useMemo(
    () => ({
      artifact,
      setArtifact,
    }),
    [artifact, setArtifact]
  );

  return (
    <ArtifactContext.Provider value={value}>
      {children}
    </ArtifactContext.Provider>
  );
}

export function useArtifact() {
  const context = useContext(ArtifactContext);
  if (!context) {
    throw new Error("useArtifact must be used inside ArtifactProvider");
  }
  return context;
}

export function useArtifactSelector<Selected>(
  selector: (artifact: UIArtifact) => Selected
) {
  const { artifact } = useArtifact();
  return useMemo(() => selector(artifact), [artifact, selector]);
}
