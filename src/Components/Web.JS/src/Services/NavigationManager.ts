// Licensed to the .NET Foundation under one or more agreements.
// The .NET Foundation licenses this file to you under the MIT license.

import '@microsoft/dotnet-js-interop';
import { resetScrollAfterNextBatch } from '../Rendering/Renderer';
import { EventDelegator } from '../Rendering/Events/EventDelegator';

let hasEnabledNavigationInterception = false;
let hasRegisteredNavigationEventListeners = false;
let hasLocationChangingEventListeners = false;

let currentHistoryIndex = 0;

// Will be initialized once someone registers
let notifyLocationChangedCallback: ((uri: string, intercepted: boolean) => Promise<void>) | null = null;
let notifyLocationChangingCallback: ((uri: string, intercepted: boolean) => Promise<boolean>) | null = null;

let popStateCallback: ((state: PopStateEvent) => Promise<void> | void) = onBrowserInitiatedPopState;

// These are the functions we're making available for invocation from .NET
export const internalFunctions = {
  listenForNavigationEvents,
  enableNavigationInterception,
  setHasLocationChangingListeners,
  navigateTo,
  getBaseURI: (): string => document.baseURI,
  getLocationHref: (): string => location.href,
};

function listenForNavigationEvents(locationChangedCallback: (uri: string, intercepted: boolean) => Promise<void>, locationChangingCallback: (uri: string, intercepted: boolean) => Promise<boolean>): void {
  notifyLocationChangedCallback = locationChangedCallback;
  notifyLocationChangingCallback = locationChangingCallback;

  if (hasRegisteredNavigationEventListeners) {
    return;
  }

  hasRegisteredNavigationEventListeners = true;
  window.addEventListener('popstate', onPopState);
  currentHistoryIndex = history.state?.index ?? 0;
}

function enableNavigationInterception(): void {
  hasEnabledNavigationInterception = true;
}

function setHasLocationChangingListeners(hasListeners: boolean) {
  hasLocationChangingEventListeners = hasListeners;
}

export function attachToEventDelegator(eventDelegator: EventDelegator): void {
  // We need to respond to clicks on <a> elements *after* the EventDelegator has finished
  // running its simulated bubbling process so that we can respect any preventDefault requests.
  // So instead of registering our own native event, register using the EventDelegator.
  eventDelegator.notifyAfterClick(event => {
    if (!hasEnabledNavigationInterception) {
      return;
    }

    if (event.button !== 0 || eventHasSpecialKey(event)) {
      // Don't stop ctrl/meta-click (etc) from opening links in new tabs/windows
      return;
    }

    if (event.defaultPrevented) {
      return;
    }

    // Intercept clicks on all <a> elements where the href is within the <base href> URI space
    // We must explicitly check if it has an 'href' attribute, because if it doesn't, the result might be null or an empty string depending on the browser
    const anchorTarget = findAnchorTarget(event);

    if (anchorTarget && canProcessAnchor(anchorTarget)) {
      const href = anchorTarget.getAttribute('href')!;
      const absoluteHref = toAbsoluteUri(href);

      if (isWithinBaseUriSpace(absoluteHref)) {
        event.preventDefault();

        if (hasLocationChangingEventListeners) {
          addToNavigationQueue(absoluteHref, true, () => {
            performInternalNavigation(absoluteHref, /* interceptedLink */ true, /* replace */ false);
          });
        } else {
          performInternalNavigation(absoluteHref, /* interceptedLink */ true, /* replace */ false);
        }
      }
    }
  });
}

// For back-compat, we need to accept multiple overloads
export function navigateTo(uri: string, options: NavigationOptions): void;
export function navigateTo(uri: string, forceLoad: boolean): void;
export function navigateTo(uri: string, forceLoad: boolean, replace: boolean): void;
export function navigateTo(uri: string, forceLoadOrOptions: NavigationOptions | boolean, replaceIfUsingOldOverload = false): void {
  const absoluteUri = toAbsoluteUri(uri);

  // Normalize the parameters to the newer overload (i.e., using NavigationOptions)
  const options: NavigationOptions = forceLoadOrOptions instanceof Object
    ? forceLoadOrOptions
    : { forceLoad: forceLoadOrOptions, replaceHistoryEntry: replaceIfUsingOldOverload };

  if (!options.forceLoad && isWithinBaseUriSpace(absoluteUri)) {
    performInternalNavigation(absoluteUri, false, options.replaceHistoryEntry);
  } else {
    // For external navigation, we work in terms of the originally-supplied uri string,
    // not the computed absoluteUri. This is in case there are some special URI formats
    // we're unable to translate into absolute URIs.
    performExternalNavigation(uri, options.replaceHistoryEntry);
  }
}

function performExternalNavigation(uri: string, replace: boolean) {
  if (location.href === uri) {
    // If you're already on this URL, you can't append another copy of it to the history stack,
    // so we can ignore the 'replace' flag. However, reloading the same URL you're already on
    // requires special handling to avoid triggering browser-specific behavior issues.
    // For details about what this fixes and why, see https://github.com/dotnet/aspnetcore/pull/10839
    const temporaryUri = uri + '?';
    history.replaceState(null, '', temporaryUri);
    location.replace(uri);
  } else if (replace) {
    location.replace(uri);
  } else {
    location.href = uri;
  }
}

function performInternalNavigation(absoluteInternalHref: string, interceptedLink: boolean, replace: boolean) {
  // Since this was *not* triggered by a back/forward gesture (that goes through a different
  // code path starting with a popstate event), we don't want to preserve the current scroll
  // position, so reset it.
  // To avoid ugly flickering effects, we don't want to change the scroll position until
  // we render the new page. As a best approximation, wait until the next batch.
  resetScrollAfterNextBatch();

  if (!replace) {
    currentHistoryIndex++;
    history.pushState({ index: currentHistoryIndex }, /* ignored title */ '', absoluteInternalHref);
  } else {
    history.replaceState({ index: currentHistoryIndex }, /* ignored title */ '', absoluteInternalHref);
  }

  notifyLocationChanged(interceptedLink);
}

function navigateDelta(delta: number): Promise<void> {
  return new Promise(resolve => {
    const oldPopStateCallback = popStateCallback;

    popStateCallback = () => {
      popStateCallback = oldPopStateCallback;
      resolve();
    };

    history.go(delta);
  });
}

async function onBrowserInitiatedPopState(state: PopStateEvent) {
  if (!hasLocationChangingEventListeners) {
    await notifyLocationChanged(false);
  } else {
    const index = state.state?.index ?? 0;
    const historyIndexAtTimeOfNavigation = currentHistoryIndex;
    const delta = currentHistoryIndex - index;
    const uri = location.href;

    // Immediately revert the navigation.
    await navigateDelta(delta);

    addToNavigationQueue(uri, false, async () => {
      let relativeDelta: number;

      if (delta === -1 || delta === 1) {
        // We make a guess that the navigation was triggered using the "back" or "forward" buttons in the browser.
        // In this case, the user intended to navigate one step relative to the current page, so we'll just reuse
        // the initial delta.
        relativeDelta = delta;
      } else {
        // In this case, we suppose that the user selected a specific entry in the history.
        // Since navigations may have happened since their selection, the offset to that entry
        // relative to the current page needs to be adjusted.
        const historyIndexDelta = historyIndexAtTimeOfNavigation - currentHistoryIndex;
        relativeDelta = delta - historyIndexDelta;
      }

      await navigateDelta(-relativeDelta);
      await notifyLocationChanged(false);
    });
  }
}

let lastNavigationPromise: Promise<void> = Promise.resolve();

function addToNavigationQueue(uri: string, intercepted: boolean, callback: (() => Promise<void> | void)) {
  lastNavigationPromise = lastNavigationPromise
    .then(() => {
      if (uri === location.href) {
        // If we attempt to navigate "forward" when there are no more history entries, the URI being navigated
        // to matches the current URI. Skip the navigation in these cases.
        return true;
      }

      return !!notifyLocationChangingCallback && notifyLocationChangingCallback(uri, intercepted);
    }).then(shouldCancel => {
      if (shouldCancel) {
        return;
      }

      return callback();
    });
}

async function notifyLocationChanged(interceptedLink: boolean) {
  if (notifyLocationChangedCallback) {
    await notifyLocationChangedCallback(location.href, interceptedLink);
  }
}

async function onPopState(state: PopStateEvent) {
  if (popStateCallback) {
    await popStateCallback(state);
  }

  currentHistoryIndex = history.state?.index ?? 0;
}

let testAnchor: HTMLAnchorElement;
export function toAbsoluteUri(relativeUri: string): string {
  testAnchor = testAnchor || document.createElement('a');
  testAnchor.href = relativeUri;
  return testAnchor.href;
}

function findAnchorTarget(event: MouseEvent): HTMLAnchorElement | null {
  // _blazorDisableComposedPath is a temporary escape hatch in case any problems are discovered
  // in this logic. It can be removed in a later release, and should not be considered supported API.
  const path = !window['_blazorDisableComposedPath'] && event.composedPath && event.composedPath();
  if (path) {
    // This logic works with events that target elements within a shadow root,
    // as long as the shadow mode is 'open'. For closed shadows, we can't possibly
    // know what internal element was clicked.
    for (let i = 0; i < path.length; i++) {
      const candidate = path[i];
      if (candidate instanceof Element && candidate.tagName === 'A') {
        return candidate as HTMLAnchorElement;
      }
    }
    return null;
  } else {
    // Since we're adding use of composedPath in a patch, retain compatibility with any
    // legacy browsers that don't support it by falling back on the older logic, even
    // though it won't work properly with ShadowDOM. This can be removed in the next
    // major release.
    return findClosestAnchorAncestorLegacy(event.target as Element | null, 'A');
  }
}

function findClosestAnchorAncestorLegacy(element: Element | null, tagName: string) {
  return !element
    ? null
    : element.tagName === tagName
      ? element
      : findClosestAnchorAncestorLegacy(element.parentElement, tagName);
}

function isWithinBaseUriSpace(href: string) {
  const baseUriWithoutTrailingSlash = toBaseUriWithoutTrailingSlash(document.baseURI!);
  const nextChar = href.charAt(baseUriWithoutTrailingSlash.length);

  return href.startsWith(baseUriWithoutTrailingSlash)
    && (nextChar === '' || nextChar === '/' || nextChar === '?' || nextChar === '#');
}

function toBaseUriWithoutTrailingSlash(baseUri: string) {
  return baseUri.substring(0, baseUri.lastIndexOf('/'));
}

function eventHasSpecialKey(event: MouseEvent) {
  return event.ctrlKey || event.shiftKey || event.altKey || event.metaKey;
}

function canProcessAnchor(anchorTarget: HTMLAnchorElement) {
  const targetAttributeValue = anchorTarget.getAttribute('target');
  const opensInSameFrame = !targetAttributeValue || targetAttributeValue === '_self';
  return opensInSameFrame && anchorTarget.hasAttribute('href') && !anchorTarget.hasAttribute('download');
}

// Keep in sync with Components/src/NavigationOptions.cs
export interface NavigationOptions {
  forceLoad: boolean;
  replaceHistoryEntry: boolean;
}
