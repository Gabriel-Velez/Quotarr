const test = require('node:test');
const assert = require('node:assert/strict');
const { buildInventory, profileName, requestKey } = require('../lib');

test('buildInventory maps requested media to Seerr profiles and defaults unrequested titles', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Alex' }],
    requests: [
      { type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 7 } },
      { type: 'tv', media: { tvdbId: 89 }, requestedBy: { id: 404 } },
    ],
    movies: [
      { id: 1, tmdbId: 42, title: 'Requested', sizeOnDisk: 2048 },
      { id: 2, tmdbId: 43, title: 'Unrequested', sizeOnDisk: 4096 },
    ],
    series: [{ id: 3, tvdbId: 89, title: 'Unknown requester', statistics: { sizeOnDisk: 8192 } }],
    assignments: {},
    defaultCategory: 'Household',
  });

  assert.deepEqual(result.profiles, [{ id: '7', name: 'Alex' }, { id: 'default', name: 'Household' }]);
  assert.deepEqual(result.items.map(({ title, profileId }) => [title, profileId]), [
    ['Requested', '7'],
    ['Unrequested', 'default'],
    ['Unknown requester', 'default'],
  ]);
});

test('manual assignments override requests, while unknown saved profile ids are ignored', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Alex' }, { id: 8, username: 'Sam' }],
    requests: [{ type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 7 } }],
    movies: [{ id: 1, tmdbId: 42, title: 'Title', sizeOnDisk: 1 }],
    series: [],
    assignments: { 'movie:42': '8' },
    defaultCategory: 'Unrequested',
  });
  assert.equal(result.items[0].profileId, '8');

  const invalidOverride = buildInventory({
    users: [{ id: 7, username: 'Alex' }],
    requests: [{ type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 7 } }],
    movies: [{ id: 1, tmdbId: 42, title: 'Title', sizeOnDisk: 1 }],
    series: [],
    assignments: { 'movie:42': 'deleted-user' },
    defaultCategory: 'Unrequested',
  });
  assert.equal(invalidOverride.items[0].profileId, '7');
});

test('admin reassignment overrides both library and request-history profiles', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Alex' }, { id: 8, username: 'Sam' }],
    requests: [{ id: 101, type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 7 } }],
    movies: [{ id: 1, tmdbId: 42, title: 'Title', sizeOnDisk: 1 }],
    series: [],
    assignments: { 'movie:42': '8' },
    reassignments: { 'movie:42': { seerrProfileId: '7', adminProfileId: '8' } },
    defaultCategory: 'Unrequested',
  });

  assert.equal(result.items[0].profileId, '8');
  assert.equal(result.requests[0].profileId, '8');
});

test('manually assigned library media appears in profile history without a Seerr request', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Alex' }, { id: 8, username: 'Derek' }],
    requests: [],
    movies: [{ id: 1, tmdbId: 42, title: 'Unrequested Movie', sizeOnDisk: 1 }],
    series: [],
    assignments: { 'movie:42': '8' },
    reassignments: { 'movie:42': { seerrProfileId: null, adminProfileId: '8' } },
    defaultCategory: 'Unrequested',
  });

  assert.deepEqual(result.requests.map(({ profileId, title, manuallyAssigned }) => ({
    profileId, title, manuallyAssigned,
  })), [{
    profileId: '8',
    title: 'Unrequested Movie',
    manuallyAssigned: true,
  }]);
});

test('all Seerr requests for a library title follow its single bar-scroll profile', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Derek' }, { id: 8, username: 'Teevo' }],
    requests: [
      { id: 101, type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 7 } },
      { id: 102, type: 'movie', media: { tmdbId: 42 }, requestedBy: { id: 8 } },
    ],
    movies: [{ id: 1, tmdbId: 42, title: 'The Odyssey', sizeOnDisk: 1 }],
    series: [],
    assignments: { 'movie:42': '8' },
    reassignments: { 'movie:42': { seerrProfileId: '7', adminProfileId: '8' } },
    defaultCategory: 'Unrequested',
  });

  assert.equal(result.items[0].profileId, '8');
  assert.equal(result.requests.length, 1);
  assert.equal(result.requests[0].profileId, '8');
  assert.equal(result.items.length, 1);
  assert.equal(result.items.reduce((total, item) => total + item.size, 0), 1);
});

test('profile names and request keys handle alternate account names and missing IDs', () => {
  assert.equal(profileName({ id: 12, plexUsername: 'Plex Alex' }), 'Plex Alex');
  assert.equal(requestKey('movie', { tmdbId: 1 }), 'movie:1');
  assert.equal(requestKey('tv', { tvdbId: 2 }), 'show:2');
  assert.equal(requestKey('movie', {}), null);
});

test('request history includes dates and keeps requests that are not in the library', () => {
  const result = buildInventory({
    users: [{ id: 7, username: 'Alex' }],
    requests: [
      {
        id: 101,
        type: 'movie',
        createdAt: '2024-01-02T00:00:00.000Z',
        media: { tmdbId: 42, posterPath: '/film.jpg', releaseDate: '2023-12-01' },
        requestedBy: { id: 7 },
      },
      {
        id: 102,
        type: 'tv',
        createdAt: '2024-02-03T00:00:00.000Z',
        media: { tvdbId: 89, name: 'Pending Show', firstAirDate: '2024-01-01' },
        requestedBy: { id: 7 },
      },
    ],
    movies: [{ id: 1, tmdbId: 42, title: 'Film', sizeOnDisk: 2048 }],
    series: [],
    assignments: {},
    defaultCategory: 'Unrequested',
  });

  assert.deepEqual(result.requests.map(({ id, title, size, inLibrary, dateRequested, dateReleased }) => ({
    id, title, size, inLibrary, dateRequested, dateReleased,
  })), [
    {
      id: '101',
      title: 'Film',
      size: 2048,
      inLibrary: true,
      dateRequested: '2024-01-02T00:00:00.000Z',
      dateReleased: '2023-12-01',
    },
    {
      id: '102',
      title: 'Pending Show',
      size: 0,
      inLibrary: false,
      dateRequested: '2024-02-03T00:00:00.000Z',
      dateReleased: '2024-01-01',
    },
  ]);
});
