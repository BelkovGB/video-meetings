# PRD: User Profile

**Date**: 2026-08-12
**Status**: Draft

## Goal

Allow an authenticated user to manage the basic personal information and
credentials associated with their account: display name, avatar, and password.

## User Scenarios

- A user opens their profile and sees their current display name, avatar, and
  read-only email address.
- A user changes their display name and sees the updated name throughout the
  application.
- A user uploads an avatar and sees it in their profile and account entry
  points.
- When other users can see an activity performed by the user, they see the
  user's avatar next to that activity.
- A user removes their avatar and sees a neutral fallback based on their
  display name everywhere the avatar would otherwise appear.
- A user changes their password by entering the old password, a new
  password, and confirmation of the new password.
- After a successful password change, the user's current session ends and they
  sign in again with the new password.
- A user receives a clear field-level error when profile data, an avatar, or
  password confirmation is invalid.

## Out of Scope

- Changing the account email address.
- Public profiles, usernames, biographies, job titles, contact details, or
  profile visibility settings.
- Account deletion or deactivation.
- Two-factor authentication, passkeys, social login, and recovery codes.
- Password recovery or a forgot-password flow.
- Avatar editing, cropping, filters, or an avatar gallery.
- Managing or terminating sessions on other devices.
- Notification and communication preferences.

## Technical Constraints

- Only an authenticated user may view or change their own profile.
- The email address is displayed as read-only and cannot be changed in this
  iteration.
- The display name is required after it has first been saved, is trimmed before
  validation, accepts Unicode characters, and contains 1 to 100 characters.
- An avatar upload accepts one JPEG, PNG, or WebP image no larger than 5 MB.
- Invalid, unsupported, or oversized avatar files are rejected without
  replacing the current avatar.
- The avatar may be shown to other authenticated users wherever they can see
  the user's activity, including shared meeting contexts. Seeing an avatar does
  not grant access to the user's profile or to otherwise restricted activity.
- Replacing or removing an avatar is reflected in the user's profile, account
  entry points, and user activity shown elsewhere in the application.
- Removing an avatar does not remove or otherwise modify the user account.
- Changing a password requires the correct old password for the account. The new password
  must differ from the current password and satisfy the existing registration
  rule: at least 9 Unicode characters and no more than 72 UTF-8 bytes.
- Password confirmation must exactly match the new password.
- A failed password change does not alter the password or end the current
  session.
- A successful password change ends the current session. Previously issued
  sessions on other devices are not managed in this iteration.
- Passwords and password hashes are never returned to the client or written to
  application logs.
- Profile controls, validation messages, keyboard focus, and avatar alternative
  text are usable with assistive technology and on desktop and mobile screens.

## Definition of Done

- [ ] An authenticated user can open a profile screen and see their current
      display name, avatar or fallback, and read-only email address.
- [ ] A user can save a valid display name of 1 to 100 characters, and the
      updated name is shown consistently throughout the application.
- [ ] Empty or overlong display names are rejected with a clear field-level
      error and do not overwrite the saved name.
- [ ] A user can upload a valid JPEG, PNG, or WebP avatar no larger than 5 MB,
      and the new avatar replaces the previous one everywhere the user's avatar
      is displayed.
- [ ] When a permitted user views another user's activity, the actor's avatar
      or neutral fallback is displayed with that activity.
- [ ] An avatar is not exposed to a user who cannot access the activity or
      shared context in which it appears.
- [ ] An unsupported, invalid, or oversized avatar is rejected with a clear
      error, while the previously saved avatar remains available.
- [ ] A user can remove their avatar and the application shows the neutral
      fallback wherever the avatar is normally displayed.
- [ ] A user can change their password by providing the correct old
      password and matching new-password fields that satisfy the password rule.
- [ ] An incorrect current password, a reused current password, a password that
      violates the password rule, or mismatched confirmation is rejected with a
      clear error and leaves the existing password valid.
- [ ] After a successful password change, the current session can no longer be
      used and the user is sent to sign in again; the old password fails and
      the new password succeeds.
- [ ] An unauthenticated user cannot view or modify profile data or retrieve an
      avatar through profile-only access.
- [ ] One user cannot read or change another user's private profile data by
      altering a request.
- [ ] Profile and password forms remain usable by keyboard and at desktop and
      mobile viewport sizes, with validation and success states announced to
      assistive technology.
