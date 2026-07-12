"use client";

import { motion } from "framer-motion";

export function Greeting() {
  return (
    <div className="flex max-w-md flex-col items-center px-6" key="overview">
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="text-center text-xl font-semibold text-foreground md:text-2xl"
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.35, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        Start a research thread
      </motion.div>
      <motion.div
        animate={{ opacity: 1, y: 0 }}
        className="mt-2 text-center text-sm text-muted-foreground"
        initial={{ opacity: 0, y: 10 }}
        transition={{ delay: 0.5, duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
      >
        Ask a question and the workspace will keep the research, sources, and deliverables together.
      </motion.div>
    </div>
  );
}
