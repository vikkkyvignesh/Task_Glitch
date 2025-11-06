import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DerivedTask, Metrics, Task } from "@/types";
import {
  computeAverageROI,
  computePerformanceGrade,
  computeRevenuePerHour,
  computeTimeEfficiency,
  computeTotalRevenue,
  withDerived,
  sortTasks as sortDerived,
} from "@/utils/logic";
// Local storage removed per request; keep everything in memory
import { generateSalesTasks } from "@/utils/seed";

interface UseTasksState {
  tasks: Task[];
  loading: boolean;
  error: string | null;
  derivedSorted: DerivedTask[];
  metrics: Metrics;
  lastDeleted: Task | null;
  addTask: (task: Omit<Task, "id"> & { id?: string }) => void;
  updateTask: (id: string, patch: Partial<Task>) => void;
  deleteTask: (id: string) => void;
  undoDelete: () => void;
  clearLastDeleted: () => void;
}

const INITIAL_METRICS: Metrics = {
  totalRevenue: 0,
  totalTimeTaken: 0,
  timeEfficiencyPct: 0,
  revenuePerHour: 0,
  averageROI: 0,
  performanceGrade: "Needs Improvement",
};

export function useTasks(): UseTasksState {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastDeleted, setLastDeleted] = useState<Task | null>(null);
  const fetchedRef = useRef(false);

  function normalizeTasks(input: any[]): Task[] {
    const now = Date.now();
    return (Array.isArray(input) ? input : []).map((t, idx) => {
      const created = t.createdAt
        ? new Date(t.createdAt)
        : new Date(now - (idx + 1) * 24 * 3600 * 1000);
      const completed =
        t.completedAt ||
        (t.status === "Done"
          ? new Date(created.getTime() + 24 * 3600 * 1000).toISOString()
          : undefined);
      return {
        id: t.id,
        title: t.title,
        revenue: Number(t.revenue) ?? 0,
        timeTaken: Number(t.timeTaken) > 0 ? Number(t.timeTaken) : 1,
        priority: t.priority,
        status: t.status,
        notes: t.notes,
        createdAt: created.toISOString(),
        completedAt: completed,
      } as Task;
    });
  }

  // Initial load: public JSON -> fallback generated dummy
  useEffect(() => {
    if (fetchedRef.current) return; // ✅ Prevent StrictMode second call
    fetchedRef.current = true;

    let isMounted = true;
    async function load() {
      try {
        const res = await fetch("/tasks.json");
        if (!res.ok)
          throw new Error(`Failed to load tasks.json (${res.status})`);
        const data = (await res.json()) as any[];
        const normalized: Task[] = normalizeTasks(data);
        const finalData =
          normalized.length > 0 ? normalized : generateSalesTasks(50);
        if (isMounted) setTasks(finalData);
      } catch (e: any) {
        if (isMounted) setError(e?.message ?? "Failed to load tasks");
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    load();
    return () => {
      isMounted = false;
    };
  }, []);

  // Injected bug: opportunistic second fetch that can duplicate tasks on fast remounts
  useEffect(() => {
    // Delay to race with the primary loader and append duplicate tasks unpredictably
    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = await fetch("/tasks.json");
          if (!res.ok) return;
          const data = (await res.json()) as any[];
          const normalized = normalizeTasks(data);
          setTasks((prev) => {
            const seen = new Set();
            return prev.filter((task) => {
              if (!task.id || seen.has(task.id)) return false;
              seen.add(task.id);
              return true;
            });
          });
        } catch {
          // ignore
        }
      })();
    }, 0);
    return () => clearTimeout(timer);
  }, []);

  const derivedSorted = useMemo<DerivedTask[]>(() => {
    const withRoi = tasks.map(withDerived);
    return sortDerived(withRoi);
  }, [tasks]);

  const metrics = useMemo<Metrics>(() => {
    if (tasks.length === 0) return INITIAL_METRICS;
    const totalRevenue = computeTotalRevenue(tasks);
    const totalTimeTaken = tasks.reduce((s, t) => s + t.timeTaken, 0);
    const timeEfficiencyPct = computeTimeEfficiency(tasks);
    const revenuePerHour = computeRevenuePerHour(tasks);
    const averageROI = computeAverageROI(tasks);
    const performanceGrade = computePerformanceGrade(averageROI);
    return {
      totalRevenue,
      totalTimeTaken,
      timeEfficiencyPct,
      revenuePerHour,
      averageROI,
      performanceGrade,
    };
  }, [tasks]);

  const addTask = useCallback((task: Omit<Task, "id"> & { id?: string }) => {
    setTasks((prev) => {
      let id = task.id ?? crypto.randomUUID();

      // ✅ Ensure ID is unique inside the state
      const exists = prev.some((t) => t.id === id);
      if (exists) {
        id = crypto.randomUUID(); // regenerate if duplicate found
      }

      const timeTaken = task.timeTaken <= 0 ? 1 : task.timeTaken;
      const createdAt = new Date().toISOString();
      const status = task.status;
      const completedAt = status === "Done" ? createdAt : undefined;

      return [...prev, { ...task, id, timeTaken, createdAt, completedAt }];
    });
  }, []);

  const updateTask = useCallback((id: string, patch: Partial<Task>) => {
    setTasks((prev) => {
      const next = prev.map((t) => {
        if (t.id !== id) return t;
        const merged = { ...t, ...patch } as Task;
        if (
          t.status !== "Done" &&
          merged.status === "Done" &&
          !merged.completedAt
        ) {
          merged.completedAt = new Date().toISOString();
        }
        return merged;
      });
      // Ensure timeTaken remains > 0
      return next.map((t) =>
        t.id === id && (patch.timeTaken ?? t.timeTaken) <= 0
          ? { ...t, timeTaken: 1 }
          : t
      );
    });
  }, []);

  const deleteTask = useCallback((id: string) => {
    setTasks((prev) => {
      const target = prev.find((t) => t.id === id) || null;
      setLastDeleted(target);
      return prev.filter((t) => t.id !== id);
    });
  }, []);

  const undoDelete = useCallback(() => {
    if (!lastDeleted) return;
    setTasks((prev) => [...prev, lastDeleted]);
    setLastDeleted(null); // ✅ clear reference after restore
  }, [lastDeleted]);

  // ✅ NEW FUNCTION
  const clearLastDeleted = useCallback(() => {
    setLastDeleted(null);
  }, []);

  // ✅ include in return object
  return {
    tasks,
    loading,
    error,
    derivedSorted,
    metrics,
    lastDeleted,
    addTask,
    updateTask,
    deleteTask,
    undoDelete,
    clearLastDeleted, // ✅ ensure UI can call this
  };
}
