import ShareClient from "@/components/ShareComponent";

export default async function Page({
  params,
}: {
  params: Promise<{ roomId: string }>;
}) {
  const { roomId } = await params;
  return <ShareClient roomId={roomId} />;
}
