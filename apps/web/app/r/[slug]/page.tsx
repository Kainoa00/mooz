import "@livekit/components-styles";
import { MeetingRoom } from "@/components/MeetingRoom";

export default async function RoomPage({ params }: PageProps<"/r/[slug]">) {
  const { slug } = await params;
  return <MeetingRoom slug={slug} />;
}
