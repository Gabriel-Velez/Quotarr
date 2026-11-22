function profileName(user) {
  return user.username || user.plexUsername || user.jellyfinUsername || user.email || `User ${user.id}`;
}

function requestKey(type, media) {
  if (!media) return null;
  if (type === 'movie' && media.tmdbId != null) return `movie:${media.tmdbId}`;
  if ((type === 'tv' || type === 'show') && media.tvdbId != null) return `show:${media.tvdbId}`;
  return null;
}

function mediaSize(value) {
  const size = Number(value);
  return Number.isFinite(size) && size > 0 ? size : 0;
}

function posterUrl(mediaPoster, serviceImages) {
  if (typeof mediaPoster === 'string' && mediaPoster.startsWith('/')) {
    return `https://image.tmdb.org/t/p/w342${mediaPoster}`;
  }

  const remotePoster = serviceImages?.find((image) => image.coverType === 'poster')?.remoteUrl;
  if (typeof remotePoster === 'string') {
    try {
      const url = new URL(remotePoster);
      if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.toString();
    } catch {
      return '';
    }
  }

  return '';
}

function buildInventory({ movies, series, requests, users, assignments, reassignments = {}, defaultCategory }) {
  const profiles = users.map((user) => ({
    id: String(user.id),
    name: profileName(user),
  }));
  profiles.push({ id: 'default', name: defaultCategory });

  const profileIds = new Set(profiles.map((profile) => profile.id));
  const assignedProfile = (key) => {
    const recordedProfile = reassignments[key]?.adminProfileId;
    const profileId = typeof recordedProfile === 'string' && profileIds.has(recordedProfile)
      ? recordedProfile
      : assignments[key];
    return profileId && profileIds.has(profileId) ? profileId : null;
  };
  const requestByMedia = new Map();
  for (const request of requests) {
    const key = requestKey(request.type, request.media);
    const requesterId = request.requestedBy?.id;
    if (key && requesterId != null && !requestByMedia.has(key)) {
      requestByMedia.set(key, {
        profileId: String(requesterId),
        posterPath: request.media.posterPath,
        createdAt: request.createdAt || '',
        releaseDate: request.media.releaseDate || request.media.firstAirDate || '',
      });
    }
  }

  const items = [
    ...movies.map((movie) => ({
      key: `movie:${movie.tmdbId ?? `radarr-${movie.id}`}`,
      title: movie.title || 'Untitled movie',
      type: 'Movie',
      size: mediaSize(movie.sizeOnDisk),
      poster: posterUrl(null, movie.images),
      path: movie.path || '',
      dateReleased: movie.releaseDate || '',
      matchKey: movie.tmdbId != null ? `movie:${movie.tmdbId}` : null,
    })),
    ...series.map((show) => ({
      key: `show:${show.tvdbId ?? `sonarr-${show.id}`}`,
      title: show.title || 'Untitled show',
      type: 'Show',
      size: mediaSize(show.statistics?.sizeOnDisk),
      poster: posterUrl(null, show.images),
      path: show.path || '',
      dateReleased: show.firstAired || '',
      matchKey: show.tvdbId != null ? `show:${show.tvdbId}` : null,
    })),
  ].map((item) => {
    const request = requestByMedia.get(item.matchKey);
    const inferredProfile = request?.profileId;
    const savedProfile = assignedProfile(item.key);
    const profileId = savedProfile
      ? savedProfile
      : inferredProfile && profileIds.has(inferredProfile)
        ? inferredProfile
        : 'default';
    const servicePoster = item.poster ? [{ coverType: 'poster', remoteUrl: item.poster }] : [];
    return {
      ...item,
      poster: posterUrl(request?.posterPath, servicePoster),
      profileId,
      requesterProfileId: inferredProfile || null,
      dateRequested: request?.createdAt || '',
      dateReleased: item.dateReleased || request?.releaseDate || '',
      inLibrary: true,
    };
  });

  const mediaByKey = new Map(items.filter((item) => item.matchKey).map((item) => [item.matchKey, item]));
  const requestEntries = [];
  const seenRequests = new Set();
  requests.forEach((request, index) => {
    const key = requestKey(request.type, request.media);
    const item = key ? mediaByKey.get(key) : undefined;
    const inferredProfile = request.requestedBy?.id == null ? null : String(request.requestedBy.id);
    const profileId = item
      ? item.profileId
      : key
        ? assignedProfile(key) || inferredProfile
        : inferredProfile;
    const requestId = request.id == null ? `${key || 'unknown'}:${profileId || 'unknown'}:${index}` : String(request.id);
    const dedupeKey = key ? `media:${key}` : `request:${requestId}`;
    if (seenRequests.has(dedupeKey)) return;
    seenRequests.add(dedupeKey);
    requestEntries.push({
      id: requestId,
      profileId,
      itemKey: item?.key || key || `request:${requestId}`,
      title: item?.title || request.media?.title || request.media?.name || request.media?.originalTitle || 'Untitled request',
      type: request.type === 'movie' ? 'Movie' : 'Show',
      size: item?.size || 0,
      poster: item?.poster || posterUrl(request.media?.posterPath),
      dateRequested: request.createdAt || '',
      dateReleased: item?.dateReleased || request.media?.releaseDate || request.media?.firstAirDate || '',
      inLibrary: Boolean(item),
    });
  });

  const requestedItemKeys = new Set(requestEntries.map((request) => request.itemKey));
  const manualEntries = items
    .filter((item) => !requestedItemKeys.has(item.key))
    .map((item) => ({
      id: `assignment:${item.key}`,
      profileId: item.profileId,
      itemKey: item.key,
      title: item.title,
      type: item.type,
      size: item.size,
      poster: item.poster,
      dateRequested: '',
      dateReleased: item.dateReleased,
      inLibrary: true,
      manuallyAssigned: true,
    }));

  return { profiles, items, requests: [...requestEntries, ...manualEntries] };
}

module.exports = { buildInventory, profileName, requestKey };
