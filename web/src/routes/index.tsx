import { createFileRoute } from "@tanstack/react-router";
import AIReceptionApp from "@/components/AIReception";

export const Route = createFileRoute("/")({
  component: App,
});

function App() {
  return <AIReceptionApp />;
}
