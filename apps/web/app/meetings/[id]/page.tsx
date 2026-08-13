import { MeetingFilesPage } from './meeting-files-page';

type MeetingPageProps = {
  params: Promise<{ id: string }>;
};

export default async function MeetingPage({ params }: MeetingPageProps) {
  const { id } = await params;

  return <MeetingFilesPage meetingId={id} />;
}
