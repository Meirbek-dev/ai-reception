import AIReceptionApp from "@/components/AIReception";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  return <AIReceptionApp />;
}
