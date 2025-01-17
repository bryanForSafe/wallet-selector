import { isMobile } from "is-mobile";
import {
  WalletModuleFactory,
  WalletBehaviourFactory,
  InjectedWallet,
  Action,
  Transaction,
  FunctionCallAction,
  Optional,
} from "@near-wallet-selector/core";
import { waitFor } from "@near-wallet-selector/core";
import type { InjectedSafePal } from "./injected-safePal";

declare global {
  interface Window {
    safePalNear: InjectedSafePal | undefined;
  }
}

export interface SafePalParams {
  iconUrl?: string;
}

interface SafePalState {
  wallet: InjectedSafePal;
}

const isInstalled = () => {
  return waitFor(() => !!window.safePalNear?.isSafePal).catch(() => false);
};

const setupSafePalState = (): SafePalState => {
  const wallet = window.safePalNear!;

  return {
    wallet,
  };
};

const SafePal: WalletBehaviourFactory<InjectedWallet> = async ({
  options,
  metadata,
  store,
  emitter,
  logger,
}) => {
  const _state = setupSafePalState();

  const cleanup = () => {
    for (const key in _state.wallet.callbacks) {
      _state.wallet.remove(key);
    }
  };

  const signOut = async () => {
    if (!_state.wallet.isSignedIn()) {
      return;
    }

    cleanup();

    const res = await _state.wallet.signOut();

    if (res === true) {
      return;
    }

    const error = new Error(
      typeof res.error === "string" ? res.error : res.error.type
    );

    // Prevent signing out by throwing.
    if (error.message === "User reject") {
      throw error;
    }

    // Continue signing out but log the issue.
    logger.log("Failed to sign out");
    logger.error(error);
  };

  const setupEvents = () => {
    _state.wallet.on("accountChanged", async (newAccountId) => {
      logger.log("onAccountChange", newAccountId);
      emitter.emit("signedOut", null);
    });

    _state.wallet.on("rpcChanged", async (rpc) => {
      logger.log("onNetworkChange", rpc);

      if (options.network.networkId !== rpc.networkId) {
        await signOut();

        emitter.emit("signedOut", null);
        emitter.emit("networkChanged", { networkId: rpc.networkId });
      }
    });
  };

  const getAccounts = () => {
    const accountId = _state.wallet.getAccountId();

    if (!accountId) {
      return [];
    }

    return [{ accountId }];
  };

  const isValidActions = (
    actions: Array<Action>
  ): actions is Array<FunctionCallAction> => {
    return actions.every((x) => x.type === "FunctionCall");
  };

  const transformActions = (actions: Array<Action>) => {
    const validActions = isValidActions(actions);

    if (!validActions) {
      throw new Error(
        `Only 'FunctionCall' actions types are supported by ${metadata.name}`
      );
    }

    return actions.map((x) => x.params);
  };

  const transformTransactions = (
    transactions: Array<Optional<Transaction, "signerId">>
  ) => {
    return transactions.map((transaction) => {
      return {
        receiverId: transaction.receiverId,
        actions: transformActions(transaction.actions),
      };
    });
  };

  if (_state.wallet && _state.wallet.isSignedIn()) {
    setupEvents();
  }

  return {
    async signIn({ contractId, methodNames }) {
      const existingAccounts = getAccounts();

      if (existingAccounts.length) {
        return existingAccounts;
      }

      const { accessKey, error } = await _state.wallet.requestSignIn({
        contractId,
        methodNames,
      });

      if (!accessKey || error) {
        await signOut();

        throw new Error(
          (typeof error === "string" ? error : error.type) ||
            "Failed to sign in"
        );
      }

      setupEvents();

      return getAccounts();
    },

    signOut,

    async getAccounts() {
      return getAccounts();
    },

    async signAndSendTransaction({ signerId, receiverId, actions }) {
      logger.log("signAndSendTransaction", { signerId, receiverId, actions });

      const { contract } = store.getState();

      if (!_state.wallet.isSignedIn() || !contract) {
        throw new Error("Wallet not signed in");
      }

      return _state.wallet
        .signAndSendTransaction({
          receiverId: receiverId || contract.contractId,
          actions: transformActions(actions),
        })
        .then((res) => {
          if (res.error) {
            throw new Error(res.error);
          }

          // Shouldn't happen but avoids inconsistent responses.
          if (!res.response?.length) {
            throw new Error("Invalid response");
          }

          return res.response[0];
        });
    },

    async signAndSendTransactions({ transactions }) {
      logger.log("signAndSendTransactions", { transactions });

      if (!_state.wallet.isSignedIn()) {
        throw new Error("Wallet not signed in");
      }

      return _state.wallet
        .requestSignTransactions({
          transactions: transformTransactions(transactions),
        })
        .then((res) => {
          if (res.error) {
            throw new Error(res.error);
          }

          // Shouldn't happen but avoids inconsistent responses.
          if (!res.response?.length) {
            throw new Error("Invalid response");
          }

          return res.response;
        });
    },
  };
};

export function setupSafePal({
  iconUrl = "./assets/safePal-icon.png",
}: SafePalParams = {}): WalletModuleFactory<InjectedWallet> {
  return async () => {
    // const mobile = isMobile();
    const installed = await isInstalled();

    // if (mobile) {
    //   return null;
    // }

    // Add extra wait to ensure safePal's sign in status is read from the
    // browser extension background env.
    await waitFor(() => !!window.safePalNear?.isSignedIn(), {
      timeout: 300,
    }).catch(() => false);

    return {
      id: "safePal",
      type: "injected",
      metadata: {
        name: "safePal",
        description: null,
        iconUrl,
        downloadUrl:
          "https://chrome.google.com/webstore/detail/safepal-extension-wallet/lgmpcpglpngdoalbgeoldeajfclnhafa?hl=zh",
        deprecated: false,
        available: installed,
      },
      init: SafePal,
    };
  };
}
