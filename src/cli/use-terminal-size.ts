import { useStdout } from "ink";
import { useEffect, useState } from "react";

export function useTerminalSize() {
  const { stdout } = useStdout();
  const size = () => ({
    columns: "columns" in stdout && typeof stdout.columns === "number" ? stdout.columns : 80,
    rows: "rows" in stdout && typeof stdout.rows === "number" ? stdout.rows : 24,
  });
  const [dimensions, setDimensions] = useState(size);
  useEffect(() => {
    const resize = () => setDimensions(size());
    stdout.on("resize", resize);
    return () => {
      stdout.off("resize", resize);
    };
  }, [stdout]);
  return dimensions;
}
