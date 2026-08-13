import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

type Meeting = {
  id: string;
  title: string;
  date: string;
};

type UserSession = {
  accessToken: string;
};

const validPassword = 'secure-password-123';
const validDate = '2026-08-03T10:00:00.000Z';

function createUniqueValue(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createMeetingTitle(prefix = 'Team sync') {
  return createUniqueValue(prefix);
}

function createEmail(prefix: string) {
  return `${createUniqueValue(prefix)}@example.com`;
}

function expectMeeting(response: request.Response, expected: Omit<Meeting, 'id'>): Meeting {
  expect(response.body).toMatchObject(expected);
  expect(response.body).toHaveProperty('id');
  expect(typeof response.body.id).toBe('string');
  expect(response.body.id).not.toHaveLength(0);
  expect(response.body).not.toHaveProperty('ownerId');

  return response.body as Meeting;
}

describe('Meetings (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  async function registerUser(): Promise<UserSession> {
    const response = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: createEmail('meeting-user'), password: validPassword })
      .expect(201);

    return response.body as UserSession;
  }

  function getUserId(accessToken: string): string {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString()) as {
      sub: string;
    };

    return payload.sub;
  }

  async function createMeeting(
    accessToken: string,
    title: string,
    date = validDate,
  ): Promise<Meeting> {
    const response = await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ title, date })
      .expect(201);

    return expectMeeting(response, { title, date });
  }

  it.each([
    ['a one-character title', 'A'],
    ['a 255-character title', 'a'.repeat(255)],
  ])('creates an authenticated user meeting with %s', async (_description, title) => {
    const user = await registerUser();

    await createMeeting(user.accessToken, title);
  });

  it('rejects creation when title is absent', async () => {
    const user = await registerUser();

    await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ date: validDate })
      .expect(400);
  });

  it('rejects creation when date is absent', async () => {
    const user = await registerUser();

    await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ title: createMeetingTitle() })
      .expect(400);
  });

  it('rejects creation without an access token', async () => {
    await request(app.getHttpServer())
      .post('/meetings')
      .send({ title: createMeetingTitle(), date: validDate })
      .expect(401);
  });

  it.each<[string, Record<string, unknown>]>([
    ['title is null', { title: null, date: validDate }],
    ['title is a number', { title: 1, date: validDate }],
    ['title is a boolean', { title: true, date: validDate }],
    ['title is an array', { title: ['Daily sync'], date: validDate }],
    ['title is an object', { title: { value: 'Daily sync' }, date: validDate }],
    ['title is an empty string', { title: '', date: validDate }],
    ['title contains only whitespace', { title: ' \t\n ', date: validDate }],
    ['title exceeds 255 characters', { title: 'a'.repeat(256), date: validDate }],
    ['date is null', { title: createMeetingTitle(), date: null }],
    ['date is not an ISO 8601 date-time', { title: createMeetingTitle(), date: 'tomorrow' }],
    ['date year is below 2000', { title: createMeetingTitle(), date: '1999-12-31T23:59:00Z' }],
    ['date year is above 2100', { title: createMeetingTitle(), date: '2101-01-01T00:00:00Z' }],
    ['date year has five digits', { title: createMeetingTitle(), date: '99999-09-09T09:59:00Z' }],
  ])('rejects creation when %s', async (_description, payload) => {
    const user = await registerUser();

    await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send(payload)
      .expect(400);
  });

  it('rejects client-controlled and unknown fields without creating a meeting', async () => {
    const user = await registerUser();
    const title = createMeetingTitle('Rejected meeting');

    await request(app.getHttpServer())
      .post('/meetings')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({
        title,
        date: validDate,
        id: 'client-controlled-id',
        ownerId: 'client-controlled-owner',
      })
      .expect(400);

    const response = await request(app.getHttpServer())
      .get('/meetings')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(response.body).not.toEqual(expect.arrayContaining([expect.objectContaining({ title })]));
  });

  it('returns owned and participant meetings without revealing inaccessible meetings', async () => {
    const firstUser = await registerUser();
    const secondUser = await registerUser();
    const participant = await registerUser();
    const firstMeeting = await createMeeting(firstUser.accessToken, createMeetingTitle('Planning'));
    const secondMeetingForFirstUser = await createMeeting(
      firstUser.accessToken,
      createMeetingTitle('Retrospective'),
    );
    const secondMeeting = await createMeeting(
      secondUser.accessToken,
      createMeetingTitle('Private meeting'),
    );
    const sharedMeeting = await createMeeting(
      secondUser.accessToken,
      createMeetingTitle('Shared meeting'),
    );
    await prisma.meetingParticipant.create({
      data: { meetingId: sharedMeeting.id, userId: getUserId(participant.accessToken) },
    });

    const response = await request(app.getHttpServer())
      .get('/meetings')
      .set('Authorization', `Bearer ${firstUser.accessToken}`)
      .expect(200);

    expect(response.body).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...firstMeeting, accessRole: 'owner' }),
        expect.objectContaining({ ...secondMeetingForFirstUser, accessRole: 'owner' }),
      ]),
    );
    expect(response.body).not.toEqual(
      expect.arrayContaining([expect.objectContaining(secondMeeting)]),
    );

    const participantResponse = await request(app.getHttpServer())
      .get('/meetings')
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(200);

    expect(participantResponse.body).toEqual([
      expect.objectContaining({ ...sharedMeeting, accessRole: 'participant' }),
    ]);
    expect(participantResponse.body[0]).not.toHaveProperty('ownerId');
  });

  it('rejects a list request without an access token', async () => {
    await request(app.getHttpServer()).get('/meetings').expect(401);
  });

  it('returns the authenticated user meeting by its identifier', async () => {
    const user = await registerUser();
    const requestedMeeting = await createMeeting(
      user.accessToken,
      createMeetingTitle('Requested meeting'),
    );
    await createMeeting(user.accessToken, createMeetingTitle('Other meeting'));

    const response = await request(app.getHttpServer())
      .get(`/meetings/${requestedMeeting.id}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject(requestedMeeting);
    expect(response.body).toMatchObject({ accessRole: 'owner' });
  });

  it('returns a meeting participant view with a non-owner access role', async () => {
    const owner = await registerUser();
    const participant = await registerUser();
    const meeting = await createMeeting(owner.accessToken, createMeetingTitle('Shared meeting'));
    await prisma.meetingParticipant.create({
      data: { meetingId: meeting.id, userId: getUserId(participant.accessToken) },
    });

    const response = await request(app.getHttpServer())
      .get(`/meetings/${meeting.id}`)
      .set('Authorization', `Bearer ${participant.accessToken}`)
      .expect(200);

    expect(response.body).toMatchObject({
      id: meeting.id,
      title: meeting.title,
      accessRole: 'participant',
    });
    expect(response.body).not.toHaveProperty('ownerId');
  });

  it('does not reveal another user meeting by its identifier', async () => {
    const owner = await registerUser();
    const anotherUser = await registerUser();
    const privateMeeting = await createMeeting(owner.accessToken, createMeetingTitle('Private'));

    const response = await request(app.getHttpServer())
      .get(`/meetings/${privateMeeting.id}`)
      .set('Authorization', `Bearer ${anotherUser.accessToken}`)
      .expect(404);

    expect(response.body).toMatchObject({
      message: 'Meeting not found',
      statusCode: 404,
    });
  });

  it('rejects a meeting request by identifier without an access token', async () => {
    const user = await registerUser();
    const meeting = await createMeeting(user.accessToken, createMeetingTitle());

    await request(app.getHttpServer()).get(`/meetings/${meeting.id}`).expect(401);
  });

  it('returns 404 when the authenticated user requested meeting does not exist', async () => {
    const user = await registerUser();

    const response = await request(app.getHttpServer())
      .get(`/meetings/${createUniqueValue('missing-meeting')}`)
      .set('Authorization', `Bearer ${user.accessToken}`)
      .expect(404);

    expect(response.body).toMatchObject({
      message: 'Meeting not found',
      statusCode: 404,
    });
  });
});
