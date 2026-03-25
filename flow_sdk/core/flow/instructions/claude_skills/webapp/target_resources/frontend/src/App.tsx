import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface HealthStatus {
  status: string;
  message: string;
}

function App() {
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const checkHealth = async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/health");
      const data = await response.json();
      setHealth(data);
    } catch (error) {
      setHealth({ status: "error", message: "Failed to connect to backend" });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
  }, []);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Web App</CardTitle>
          <CardDescription>
            React + TypeScript + Tailwind + FastAPI
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <div
              className={`w-3 h-3 rounded-full ${
                health?.status === "ok"
                  ? "bg-green-500"
                  : health?.status === "error"
                  ? "bg-red-500"
                  : "bg-yellow-500"
              }`}
            />
            <span className="text-sm text-muted-foreground">
              Backend: {health?.message || "Checking..."}
            </span>
          </div>
          <Button onClick={checkHealth} disabled={loading} className="w-full">
            {loading ? "Checking..." : "Check Health"}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

export default App;
