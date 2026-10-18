import { NewMeetingButton } from "@/components/NewMeetingButton";

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center gap-6 p-6">
      <div className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">mooz</h1>
        <p className="text-muted">
          Video meetings where everyone can bring their own AI agent. Ask it out loud, it answers
          in the call.
        </p>
      </div>
      <NewMeetingButton />
    </main>
  );
}
