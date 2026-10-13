import Alert from '@app/components/Common/Alert';
import Badge from '@app/components/Common/Badge';
import Modal from '@app/components/Common/Modal';
import type { RequestOverrides } from '@app/components/RequestModal/AdvancedRequester';
import AdvancedRequester from '@app/components/RequestModal/AdvancedRequester';
import QuotaDisplay from '@app/components/RequestModal/QuotaDisplay';
import RequestModalLoadError from '@app/components/RequestModal/RequestModalLoadError';
import SearchByNameModal from '@app/components/RequestModal/SearchByNameModal';
import {
  filterVisibleSeasons,
  getInitialSeasonSelection,
  getValidatedSeasonSelection,
} from '@app/components/RequestModal/seasonSelection';
import useSettings from '@app/hooks/useSettings';
import useToasts from '@app/hooks/useToasts';
import { useUser } from '@app/hooks/useUser';
import globalMessages from '@app/i18n/globalMessages';
import defineMessages from '@app/utils/defineMessages';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import type { MediaRequest } from '@server/entity/MediaRequest';
import type SeasonRequest from '@server/entity/SeasonRequest';
import type { NonFunctionProperties } from '@server/interfaces/api/common';
import type { QuotaResponse } from '@server/interfaces/api/userInterfaces';
import { Permission } from '@server/lib/permissions';
import type { TvDetails } from '@server/models/Tv';
import axios from 'axios';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useIntl } from 'react-intl';
import useSWR, { mutate } from 'swr';

const messages = defineMessages('components.RequestModal', {
  requestadmin: 'This request will be approved automatically.',
  requestSuccess: '<strong>{title}</strong> requested successfully!',
  requestseriestitle: 'Request Series',
  requestseries4ktitle: 'Request Series in 4K',
  edit: 'Edit Request',
  approve: 'Approve Request',
  cancel: 'Cancel Request',
  pendingrequest: 'Pending Request',
  pending4krequest: 'Pending 4K Request',
  requestfrom: "{username}'s request is pending approval.",
  requestseasons:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}}',
  requestseasons4k:
    'Request {seasonCount} {seasonCount, plural, one {Season} other {Seasons}} in 4K',
  alreadyrequested: 'Already Requested',
  selectseason: 'Select Season(s)',
  season: 'Season',
  numberofepisodes: '# of Episodes',
  seasonnumber: 'Season {number}',
  errorediting: 'Something went wrong while editing the request.',
  requestedited: 'Request for <strong>{title}</strong> edited successfully!',
  requestApproved: 'Request for <strong>{title}</strong> approved!',
  requestcancelled: 'Request for <strong>{title}</strong> canceled.',
  autoapproval: 'Automatic Approval',
  requesterror: 'Something went wrong while submitting the request.',
  pendingapproval: 'Your request is pending approval.',
});

interface RequestModalProps extends React.HTMLAttributes<HTMLDivElement> {
  tmdbId: number;
  onCancel?: () => void;
  onComplete?: (newStatus: MediaStatus) => void;
  onUpdating?: (isUpdating: boolean) => void;
  is4k?: boolean;
  initialSeasonNumber?: number;
  visibleSeasonNumbers?: number[];
  editRequest?: NonFunctionProperties<MediaRequest>;
}

const TvRequestModal = ({
  onCancel,
  onComplete,
  tmdbId,
  onUpdating,
  editRequest,
  is4k = false,
  initialSeasonNumber,
  visibleSeasonNumbers,
}: RequestModalProps) => {
  const settings = useSettings();
  const { addToast } = useToasts();
  const [isRetryingLoad, setIsRetryingLoad] = useState(false);
  const editingSeasons = useMemo(
    () => (editRequest?.seasons ?? []).map((season) => season.seasonNumber),
    [editRequest]
  );
  const {
    data,
    error,
    mutate: retrySeries,
  } = useSWR<TvDetails>(`/api/v1/tv/${tmdbId}`);
  const [requestOverrides, setRequestOverrides] =
    useState<RequestOverrides | null>(null);
  const [selectedSeasons, setSelectedSeasons] = useState<number[]>(
    editRequest
      ? editingSeasons
      : initialSeasonNumber === undefined
        ? []
        : [initialSeasonNumber]
  );
  const intl = useIntl();
  const { user, hasPermission } = useUser();
  const [searchModal, setSearchModal] = useState<{
    show: boolean;
  }>({
    show: true,
  });
  const [tvdbId, setTvdbId] = useState<number | undefined>(undefined);
  const {
    data: quota,
    error: quotaError,
    mutate: retryQuota,
  } = useSWR<QuotaResponse>(
    user &&
      (!requestOverrides?.user?.id || hasPermission(Permission.MANAGE_USERS))
      ? `/api/v1/user/${requestOverrides?.user?.id ?? user.id}/quota`
      : null
  );

  const currentlyRemaining =
    (quota?.tv.remaining ?? 0) -
    selectedSeasons.length +
    (editRequest?.seasons ?? []).length;

  const retryLoad = useCallback(async () => {
    setIsRetryingLoad(true);
    await Promise.allSettled([retrySeries(), retryQuota()]);
    setIsRetryingLoad(false);
  }, [retryQuota, retrySeries]);

  const updateRequest = async (alsoApproveRequest = false) => {
    if (!editRequest) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      mutate('/api/v1/request/count');
    }

    try {
      if (selectedSeasons.length > 0) {
        await axios.put(`/api/v1/request/${editRequest.id}`, {
          mediaType: 'tv',
          serverId: requestOverrides?.server,
          profileId: requestOverrides?.profile,
          rootFolder: requestOverrides?.folder,
          languageProfileId: requestOverrides?.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides?.tags,
          seasons: selectedSeasons.sort((a, b) => a - b),
        });

        if (alsoApproveRequest) {
          await axios.post(`/api/v1/request/${editRequest.id}/approve`);
        }
      } else {
        await axios.delete(`/api/v1/request/${editRequest.id}`);
      }
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');
      mutate('/api/v1/request/count');

      addToast(
        <span>
          {selectedSeasons.length > 0
            ? intl.formatMessage(
                alsoApproveRequest
                  ? messages.requestApproved
                  : messages.requestedited,
                {
                  title: data?.name,
                  strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
                }
              )
            : intl.formatMessage(messages.requestcancelled, {
                title: data?.name,
                strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
              })}
        </span>,
        {
          appearance: 'success',
          autoDismiss: true,
        }
      );
      if (onComplete) {
        onComplete(MediaStatus.PENDING);
      }
    } catch {
      addToast(<span>{intl.formatMessage(messages.errorediting)}</span>, {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const sendRequest = async () => {
    if (initialSeasonNumber !== undefined && !initialSeasonRequestable) {
      return;
    }

    if (
      visibleSeasonNumbers &&
      !settings.currentSettings.partialRequestsEnabled
    ) {
      return;
    }

    if (
      settings.currentSettings.partialRequestsEnabled &&
      validatedSelectedSeasons.length === 0
    ) {
      return;
    }

    if (onUpdating) {
      onUpdating(true);
      mutate('/api/v1/request/count');
    }

    try {
      let overrideParams = {};
      if (requestOverrides) {
        overrideParams = {
          serverId: requestOverrides.server,
          profileId: requestOverrides.profile,
          rootFolder: requestOverrides.folder,
          languageProfileId: requestOverrides.language,
          userId: requestOverrides?.user?.id,
          tags: requestOverrides.tags,
        };
      }
      const response = await axios.post<MediaRequest>('/api/v1/request', {
        mediaId: data?.id,
        tvdbId: tvdbId ?? data?.externalIds.tvdbId,
        mediaType: 'tv',
        is4k,
        ignoreQuota: requestOverrides?.ignoreQuota,
        seasons: settings.currentSettings.partialRequestsEnabled
          ? [...validatedSelectedSeasons].sort((a, b) => a - b)
          : getAllSeasons().filter(
              (season) => !getAllRequestedSeasons().includes(season)
            ),
        ...overrideParams,
      });
      mutate('/api/v1/request?filter=all&take=10&sort=modified&skip=0');

      if (response.data) {
        if (onComplete) {
          onComplete(response.data.media.status);
        }
        addToast(
          <span>
            {intl.formatMessage(messages.requestSuccess, {
              title: data?.name,
              strong: (msg: React.ReactNode) => <strong>{msg}</strong>,
            })}
          </span>,
          { appearance: 'success', autoDismiss: true }
        );
      }
    } catch {
      addToast(intl.formatMessage(messages.requesterror), {
        appearance: 'error',
        autoDismiss: true,
      });
    } finally {
      if (onUpdating) {
        onUpdating(false);
      }
    }
  };

  const getAllSeasons = useCallback((): number[] => {
    let allSeasons = (data?.seasons ?? []).filter(
      (season) => season.episodeCount !== 0
    );
    if (!settings.currentSettings.enableSpecialEpisodes) {
      allSeasons = allSeasons.filter((season) => season.seasonNumber > 0);
    }
    return allSeasons.map((season) => season.seasonNumber);
  }, [data, settings.currentSettings.enableSpecialEpisodes]);

  const getAllRequestedSeasons = useCallback((): number[] => {
    const requestedSeasons = (data?.mediaInfo?.requests ?? [])
      .filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      )
      .reduce((requestedSeasons, request) => {
        return [
          ...requestedSeasons,
          ...request.seasons
            .filter((season) => !editingSeasons.includes(season.seasonNumber))
            .map((sr) => sr.seasonNumber),
        ];
      }, [] as number[]);

    const availableSeasons = (data?.mediaInfo?.seasons ?? [])
      .filter(
        (season) =>
          (season[is4k ? 'status4k' : 'status'] === MediaStatus.AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] ===
              MediaStatus.PARTIALLY_AVAILABLE ||
            season[is4k ? 'status4k' : 'status'] === MediaStatus.PROCESSING) &&
          !requestedSeasons.includes(season.seasonNumber)
      )
      .map((season) => season.seasonNumber);

    return [...requestedSeasons, ...availableSeasons];
  }, [data, editingSeasons, is4k]);

  const isSelectedSeason = (seasonNumber: number): boolean =>
    selectedSeasons.includes(seasonNumber);

  const toggleSeason = (seasonNumber: number): void => {
    // If this season already has a pending request, don't allow it to be toggled
    if (getAllRequestedSeasons().includes(seasonNumber)) {
      return;
    }

    // If there are no more remaining requests available, block toggle
    if (
      quota?.tv.limit &&
      currentlyRemaining <= 0 &&
      !isSelectedSeason(seasonNumber)
    ) {
      return;
    }

    if (selectedSeasons.includes(seasonNumber)) {
      setSelectedSeasons((seasons) =>
        seasons.filter((sn) => sn !== seasonNumber)
      );
    } else {
      setSelectedSeasons((seasons) => [...seasons, seasonNumber]);
    }
  };

  const unrequestedSeasons = getAllSeasons().filter(
    (season) =>
      (visibleSeasonNumbers === undefined ||
        visibleSeasonNumbers.includes(season)) &&
      !getAllRequestedSeasons().includes(season)
  );

  const validatedSelectedSeasons = getValidatedSeasonSelection({
    selectedSeasonNumbers: selectedSeasons,
    knownSeasonNumbers: getAllSeasons(),
    unavailableSeasonNumbers: getAllRequestedSeasons(),
    visibleSeasonNumbers,
  });

  const initialSeasonRequestable =
    getInitialSeasonSelection({
      initialSeasonNumber,
      partialRequestsEnabled: settings.currentSettings.partialRequestsEnabled,
      knownSeasonNumbers: getAllSeasons(),
      unavailableSeasonNumbers: getAllRequestedSeasons(),
    }).length === 1;

  useEffect(() => {
    if (
      !editRequest &&
      data &&
      initialSeasonNumber !== undefined &&
      !initialSeasonRequestable
    ) {
      setSelectedSeasons((seasons) =>
        seasons.length === 1 && seasons[0] === initialSeasonNumber
          ? []
          : seasons
      );
    }
  }, [data, editRequest, initialSeasonNumber, initialSeasonRequestable]);

  useEffect(() => {
    if (!editRequest && data) {
      setSelectedSeasons((seasons) => {
        const validated = getValidatedSeasonSelection({
          selectedSeasonNumbers: seasons,
          knownSeasonNumbers: getAllSeasons(),
          unavailableSeasonNumbers: getAllRequestedSeasons(),
          visibleSeasonNumbers,
        });
        return seasons.length === validated.length &&
          seasons.every((season, index) => season === validated[index])
          ? seasons
          : validated;
      });
    }
  }, [
    data,
    editRequest,
    getAllRequestedSeasons,
    getAllSeasons,
    visibleSeasonNumbers,
  ]);

  const toggleAllSeasons = (): void => {
    // If the user has a quota and not enough requests for all seasons, block toggleAllSeasons
    if (
      quota?.tv.limit &&
      (quota?.tv.remaining ?? 0) < unrequestedSeasons.length
    ) {
      return;
    }

    if (
      data &&
      selectedSeasons.length >= 0 &&
      selectedSeasons.length < unrequestedSeasons.length
    ) {
      setSelectedSeasons(unrequestedSeasons);
    } else {
      setSelectedSeasons([]);
    }
  };

  const isAllSeasons = (): boolean => {
    if (!data) {
      return false;
    }
    return (
      validatedSelectedSeasons.filter((season) => season !== 0).length ===
      unrequestedSeasons.filter((season) => season !== 0).length
    );
  };

  const getSeasonRequest = (
    seasonNumber: number
  ): SeasonRequest | undefined => {
    let seasonRequest: SeasonRequest | undefined;

    if (
      data?.mediaInfo &&
      (data.mediaInfo.requests || []).filter(
        (request) =>
          request.is4k === is4k &&
          request.status !== MediaRequestStatus.DECLINED &&
          request.status !== MediaRequestStatus.COMPLETED
      ).length > 0
    ) {
      data.mediaInfo.requests
        .filter(
          (request) =>
            request.is4k === is4k &&
            request.status !== MediaRequestStatus.DECLINED &&
            request.status !== MediaRequestStatus.COMPLETED
        )
        .forEach((request) => {
          if (!seasonRequest) {
            seasonRequest = request.seasons.find(
              (season) =>
                season.seasonNumber === seasonNumber &&
                season.status !== MediaRequestStatus.COMPLETED
            );
          }
        });
    }

    return seasonRequest;
  };

  const isOwner = editRequest && editRequest.requestedBy.id === user?.id;

  if (error || quotaError) {
    return (
      <RequestModalLoadError
        title={intl.formatMessage(
          editRequest
            ? is4k
              ? messages.pending4krequest
              : messages.pendingrequest
            : is4k
              ? messages.requestseries4ktitle
              : messages.requestseriestitle
        )}
        subTitle={data?.name}
        onCancel={onCancel}
        onRetry={() => void retryLoad()}
        retrying={isRetryingLoad}
        backdrop={
          data?.backdropPath
            ? `https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data.backdropPath}`
            : undefined
        }
      />
    );
  }

  return data && !error && !data.externalIds.tvdbId && searchModal.show ? (
    <SearchByNameModal
      tvdbId={tvdbId}
      setTvdbId={setTvdbId}
      closeModal={() => setSearchModal({ show: false })}
      onCancel={onCancel}
      modalTitle={intl.formatMessage(
        is4k ? messages.requestseries4ktitle : messages.requestseriestitle
      )}
      modalSubTitle={data.name}
      tmdbId={tmdbId}
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    />
  ) : (
    <Modal
      loading={!data || !quota}
      backgroundClickable
      onCancel={tvdbId ? () => setSearchModal({ show: true }) : onCancel}
      onOk={() =>
        editRequest
          ? hasPermission(Permission.MANAGE_REQUESTS)
            ? updateRequest(true)
            : updateRequest()
          : sendRequest()
      }
      title={intl.formatMessage(
        editRequest
          ? is4k
            ? messages.pending4krequest
            : messages.pendingrequest
          : is4k
            ? messages.requestseries4ktitle
            : messages.requestseriestitle
      )}
      subTitle={data?.name}
      okText={
        editRequest
          ? selectedSeasons.length === 0
            ? intl.formatMessage(messages.cancel)
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? intl.formatMessage(messages.approve)
              : intl.formatMessage(messages.edit)
          : unrequestedSeasons.length === 0
            ? intl.formatMessage(messages.alreadyrequested)
            : !settings.currentSettings.partialRequestsEnabled
              ? intl.formatMessage(
                  is4k ? globalMessages.request4k : globalMessages.request
                )
              : validatedSelectedSeasons.length === 0
                ? intl.formatMessage(messages.selectseason)
                : intl.formatMessage(
                    is4k ? messages.requestseasons4k : messages.requestseasons,
                    {
                      seasonCount: validatedSelectedSeasons.length,
                    }
                  )
      }
      okDisabled={
        editRequest
          ? false
          : visibleSeasonNumbers !== undefined &&
              !settings.currentSettings.partialRequestsEnabled
            ? true
            : initialSeasonNumber !== undefined && !initialSeasonRequestable
              ? true
              : !settings.currentSettings.partialRequestsEnabled &&
                  quota?.tv.limit &&
                  unrequestedSeasons.length > quota.tv.limit &&
                  !requestOverrides?.ignoreQuota
                ? true
                : unrequestedSeasons.length === 0 ||
                  (settings.currentSettings.partialRequestsEnabled &&
                    validatedSelectedSeasons.length === 0)
      }
      okButtonType={
        editRequest
          ? settings.currentSettings.partialRequestsEnabled &&
            selectedSeasons.length === 0
            ? 'danger'
            : hasPermission(Permission.MANAGE_REQUESTS)
              ? 'success'
              : 'primary'
          : 'primary'
      }
      cancelText={
        editRequest
          ? intl.formatMessage(globalMessages.close)
          : tvdbId
            ? intl.formatMessage(globalMessages.back)
            : intl.formatMessage(globalMessages.cancel)
      }
      backdrop={`https://image.tmdb.org/t/p/w1920_and_h800_multi_faces/${data?.backdropPath}`}
    >
      {editRequest
        ? isOwner
          ? intl.formatMessage(messages.pendingapproval)
          : intl.formatMessage(messages.requestfrom, {
              username: editRequest?.requestedBy.displayName,
            })
        : null}
      {hasPermission(
        [
          Permission.MANAGE_REQUESTS,
          is4k ? Permission.AUTO_APPROVE_4K : Permission.AUTO_APPROVE,
          is4k ? Permission.AUTO_APPROVE_4K_TV : Permission.AUTO_APPROVE_TV,
        ],
        { type: 'or' }
      ) &&
        !(
          quota?.tv.limit &&
          !settings.currentSettings.partialRequestsEnabled &&
          unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
        ) &&
        getAllRequestedSeasons().length < getAllSeasons().length &&
        !editRequest && (
          <div className="mt-6">
            <Alert
              title={intl.formatMessage(messages.requestadmin)}
              type="info"
            />
          </div>
        )}
      {(quota?.tv.limit ?? 0) > 0 && (
        <QuotaDisplay
          mediaType="tv"
          quota={quota?.tv}
          remaining={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? 0
              : currentlyRemaining
          }
          userOverride={
            requestOverrides?.user && requestOverrides.user.id !== user?.id
              ? requestOverrides?.user?.id
              : undefined
          }
          overLimit={
            !settings.currentSettings.partialRequestsEnabled &&
            unrequestedSeasons.length > (quota?.tv.remaining ?? 0)
              ? unrequestedSeasons.length
              : undefined
          }
        />
      )}
      <div className="flex flex-col">
        <div className="-mx-4 sm:mx-0">
          <div className="inline-block min-w-full py-2 align-middle">
            <div className="overflow-hidden border border-gray-700 shadow backdrop-blur sm:rounded-lg">
              <table className="min-w-full">
                <thead>
                  <tr>
                    <th
                      className={`w-16 bg-gray-700/80 px-4 py-3 ${
                        !settings.currentSettings.partialRequestsEnabled &&
                        'hidden'
                      }`}
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isAllSeasons()}
                        aria-label={intl.formatMessage(messages.selectseason)}
                        disabled={Boolean(
                          quota?.tv.limit &&
                          (quota.tv.remaining ?? 0) < unrequestedSeasons.length
                        )}
                        onClick={() => toggleAllSeasons()}
                        onKeyDown={(event) => {
                          if (event.key === ' ' || event.key === 'Enter') {
                            event.preventDefault();
                            toggleAllSeasons();
                          }
                        }}
                        className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none disabled:cursor-not-allowed ${
                          quota?.tv.limit &&
                          (quota.tv.remaining ?? 0) < unrequestedSeasons.length
                            ? 'opacity-50'
                            : ''
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'bg-indigo-500' : 'bg-gray-800'
                          } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                        />
                        <span
                          aria-hidden="true"
                          className={`${
                            isAllSeasons() ? 'translate-x-5' : 'translate-x-0'
                          } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                        />
                      </button>
                    </th>
                    <th className="bg-gray-700/80 px-1 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.season)}
                    </th>
                    <th className="bg-gray-700/80 px-5 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(messages.numberofepisodes)}
                    </th>
                    <th className="bg-gray-700/80 px-2 py-3 text-left text-xs font-medium uppercase leading-4 tracking-wider text-gray-200 md:px-6">
                      {intl.formatMessage(globalMessages.status)}
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-700">
                  {filterVisibleSeasons(
                    (data?.seasons ?? []).filter(
                      (season) =>
                        season.episodeCount !== 0 &&
                        (settings.currentSettings.enableSpecialEpisodes ||
                          season.seasonNumber !== 0)
                    ),
                    visibleSeasonNumbers
                  ).map((season) => {
                    const seasonRequest = getSeasonRequest(season.seasonNumber);
                    const mediaSeason = data?.mediaInfo?.seasons.find(
                      (sn) =>
                        sn.seasonNumber === season.seasonNumber &&
                        sn[is4k ? 'status4k' : 'status'] !==
                          MediaStatus.UNKNOWN &&
                        sn[is4k ? 'status4k' : 'status'] !== MediaStatus.DELETED
                    );
                    const seasonToggleDisabled = Boolean(
                      mediaSeason ||
                      (quota?.tv.limit &&
                        currentlyRemaining <= 0 &&
                        !isSelectedSeason(season.seasonNumber)) ||
                      (seasonRequest &&
                        !editingSeasons.includes(season.seasonNumber))
                    );
                    return (
                      <tr key={`season-${season.id}`}>
                        <td
                          className={`whitespace-nowrap px-4 py-4 text-sm font-medium leading-5 text-gray-100 ${
                            !settings.currentSettings.partialRequestsEnabled &&
                            'hidden'
                          }`}
                        >
                          <button
                            type="button"
                            role="checkbox"
                            aria-checked={
                              !!mediaSeason ||
                              (!!seasonRequest &&
                                !editingSeasons.includes(
                                  season.seasonNumber
                                )) ||
                              isSelectedSeason(season.seasonNumber)
                            }
                            aria-label={
                              season.seasonNumber === 0
                                ? intl.formatMessage(globalMessages.specials)
                                : intl.formatMessage(messages.seasonnumber, {
                                    number: season.seasonNumber,
                                  })
                            }
                            disabled={seasonToggleDisabled}
                            onClick={() => toggleSeason(season.seasonNumber)}
                            onKeyDown={(event) => {
                              if (event.key === ' ' || event.key === 'Enter') {
                                event.preventDefault();
                                toggleSeason(season.seasonNumber);
                              }
                            }}
                            className={`relative inline-flex h-5 w-10 flex-shrink-0 cursor-pointer items-center justify-center pt-2 focus:outline-none disabled:cursor-not-allowed ${
                              seasonToggleDisabled ? 'opacity-50' : ''
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className={`${
                                !!mediaSeason ||
                                (!!seasonRequest &&
                                  !editingSeasons.includes(
                                    season.seasonNumber
                                  )) ||
                                isSelectedSeason(season.seasonNumber)
                                  ? 'bg-indigo-500'
                                  : 'bg-gray-700'
                              } absolute mx-auto h-4 w-9 rounded-full transition-colors duration-200 ease-in-out`}
                            />
                            <span
                              aria-hidden="true"
                              className={`${
                                !!mediaSeason ||
                                (!!seasonRequest &&
                                  !editingSeasons.includes(
                                    season.seasonNumber
                                  )) ||
                                isSelectedSeason(season.seasonNumber)
                                  ? 'translate-x-5'
                                  : 'translate-x-0'
                              } absolute left-0 inline-block h-5 w-5 rounded-full border border-gray-200 bg-white shadow transition-transform duration-200 ease-in-out group-focus:border-blue-300 group-focus:ring`}
                            />
                          </button>
                        </td>
                        <td className="whitespace-nowrap px-1 py-4 text-sm font-medium leading-5 text-gray-100 md:px-6">
                          {season.seasonNumber === 0
                            ? intl.formatMessage(globalMessages.specials)
                            : intl.formatMessage(messages.seasonnumber, {
                                number: season.seasonNumber,
                              })}
                        </td>
                        <td className="whitespace-nowrap px-5 py-4 text-sm leading-5 text-gray-200 md:px-6">
                          {season.episodeCount}
                        </td>
                        <td className="whitespace-nowrap py-4 pr-2 text-sm leading-5 text-gray-200 md:px-6">
                          {!seasonRequest && !mediaSeason && (
                            <Badge>
                              {intl.formatMessage(globalMessages.notrequested)}
                            </Badge>
                          )}
                          {!mediaSeason &&
                            seasonRequest?.status ===
                              MediaRequestStatus.PENDING && (
                              <Badge badgeType="warning">
                                {intl.formatMessage(globalMessages.pending)}
                              </Badge>
                            )}
                          {((!mediaSeason &&
                            seasonRequest?.status ===
                              MediaRequestStatus.APPROVED) ||
                            mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                              MediaStatus.PROCESSING) && (
                            <Badge badgeType="primary">
                              {intl.formatMessage(globalMessages.requested)}
                            </Badge>
                          )}
                          {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                            MediaStatus.PARTIALLY_AVAILABLE && (
                            <Badge badgeType="success">
                              {intl.formatMessage(
                                globalMessages.partiallyavailable
                              )}
                            </Badge>
                          )}
                          {mediaSeason?.[is4k ? 'status4k' : 'status'] ===
                            MediaStatus.AVAILABLE && (
                            <Badge badgeType="success">
                              {intl.formatMessage(globalMessages.available)}
                            </Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
      {hasPermission(
        [Permission.REQUEST_ADVANCED, Permission.MANAGE_REQUESTS],
        { type: 'or' }
      ) && (
        <AdvancedRequester
          type="tv"
          tmdbId={tmdbId}
          is4k={is4k}
          isAnime={data?.keywords.some(
            (keyword) => keyword.id === ANIME_KEYWORD_ID
          )}
          quota={quota}
          onChange={(overrides) => setRequestOverrides(overrides)}
          requestUser={editRequest?.requestedBy}
          requestId={editRequest?.id}
          defaultOverrides={
            editRequest
              ? {
                  folder: editRequest.rootFolder,
                  profile: editRequest.profileId,
                  server: editRequest.serverId,
                  language: editRequest.languageProfileId,
                  tags: editRequest.tags,
                }
              : undefined
          }
        />
      )}
    </Modal>
  );
};

export default TvRequestModal;
