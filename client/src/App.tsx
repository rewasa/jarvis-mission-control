import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import { Header, HeaderProvider } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { Board } from './components/Board';
import { NewTaskPage } from './components/NewTaskPage';
import { TaskDetailPage } from './components/TaskDetailPage';
import { SettingsPage } from './components/SettingsPage';
import { RoutinesPage } from './components/RoutinesPage';
import { SkillsPage } from './components/SkillsPage';
import { FileBrowserPage } from './components/FileBrowserPage';
import { useTasks } from './hooks/useTasks';
import { useTheme } from './hooks/useTheme';

function AppShell() {
  useTasks();
  useTheme();

  return (
    <div className="flex h-dvh overflow-hidden bg-surface dark:bg-zinc-900 sm:h-screen sm:bg-sidebar dark:sm:bg-zinc-950">
      <Sidebar />
      <main className="flex flex-1 flex-col min-w-0 overflow-hidden bg-surface pb-[calc(3.75rem_+_env(safe-area-inset-bottom))] dark:bg-zinc-900 sm:m-2 sm:ml-0 sm:rounded-xl sm:border sm:border-zinc-200 sm:pb-0 sm:shadow-sm sm:dark:border-zinc-800">
        <HeaderProvider>
          <Header />
          <Routes>
            <Route path="/" element={<Board />} />
            <Route path="/tasks/new" element={<NewTaskPage />} />
            <Route path="/tasks/:taskId" element={<TaskDetailPage />} />
            <Route path="/cron" element={<Navigate to="/routines" replace />} />
            <Route path="/routines" element={<RoutinesPage />} />
            <Route path="/routines/new" element={<RoutinesPage />} />
            <Route path="/routines/:routineId/edit" element={<RoutinesPage />} />
            <Route path="/routines/:routineId/runs" element={<RoutinesPage />} />
            <Route path="/routines/:routineId/runs/:runId" element={<RoutinesPage />} />
            <Route path="/routines/:routineId" element={<RoutinesPage />} />
            <Route path="/skills" element={<SkillsPage />} />
            <Route path="/files" element={<FileBrowserPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </HeaderProvider>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
