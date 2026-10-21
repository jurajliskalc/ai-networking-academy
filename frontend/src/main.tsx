import { StrictMode, lazy, Suspense, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, Route, Routes, useLocation } from 'react-router-dom';
import './index.css';
import { ProgressProvider } from './store';
import Layout from './components/Layout';
import { Loading } from './components/ui';
import Dashboard from './pages/Dashboard';
import ErrorBoundary from './components/ErrorBoundary';

const LearningPath = lazy(() => import('./pages/LearningPath'));
const ModulePage = lazy(() => import('./pages/ModulePage'));
const LessonPage = lazy(() => import('./pages/LessonPage'));
const QuizPage = lazy(() => import('./pages/QuizPage'));
const Labs = lazy(() => import('./pages/Labs'));
const LabPage = lazy(() => import('./pages/LabPage'));
const Simulator = lazy(() => import('./pages/Simulator'));
const Visualize = lazy(() => import('./pages/Visualize'));
const Exams = lazy(() => import('./pages/Exams'));
const ExamSession = lazy(() => import('./pages/ExamSession'));
const Flashcards = lazy(() => import('./pages/Flashcards'));
const Reference = lazy(() => import('./pages/Reference'));
const ProgressPage = lazy(() => import('./pages/ProgressPage'));
const Settings = lazy(() => import('./pages/Settings'));
const NotFound = lazy(() => import('./pages/NotFound'));

function Guarded({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ProgressProvider>
      <HashRouter>
        <Layout>
          <Guarded>
          <Suspense fallback={<Loading />}>
            <Routes>
              <Route path="/" element={<Dashboard />} />
              <Route path="/path" element={<LearningPath />} />
              <Route path="/module/:id" element={<ModulePage />} />
              <Route path="/lesson/:id" element={<LessonPage />} />
              <Route path="/quiz/:id" element={<QuizPage />} />
              <Route path="/labs" element={<Labs />} />
              <Route path="/labs/:id" element={<LabPage />} />
              <Route path="/simulator" element={<Simulator />} />
              <Route path="/visualize" element={<Visualize />} />
              <Route path="/visualize/:id" element={<Visualize />} />
              <Route path="/exams" element={<Exams />} />
              <Route path="/exams/:id" element={<ExamSession />} />
              <Route path="/flashcards" element={<Flashcards />} />
              <Route path="/reference" element={<Reference />} />
              <Route path="/progress" element={<ProgressPage />} />
              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Suspense>
          </Guarded>
        </Layout>
      </HashRouter>
    </ProgressProvider>
  </StrictMode>,
);
