export class CreateMeetingCommand {
  constructor(
    public readonly title: string,
    public readonly date: string,
    public readonly ownerId: string,
  ) {}
}
