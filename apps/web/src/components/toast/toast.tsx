/** biome-ignore-all lint/suspicious/noArrayIndexKey: Not Needed Here*/
"use client";

import { CheckCircle, CircleX, Info, TriangleAlert, X } from "lucide-react";
import type { ReactNode } from "react";
import { toast as sonnerToast } from "sonner";

interface ToastProps {
  id: string | number;
  title: string;
  description?: string;
  bulletPoints?: string[];
  variant?: "info" | "success" | "warning" | "error";
  actions?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    icon?: ReactNode;
  }[];
  quickAction?: {
    label?: string;
    onClick: () => void;
    disabled?: boolean;
    icon?: ReactNode;
  };
}

export default function toast(toast: Omit<ToastProps, "id">) {
  return sonnerToast.custom((id) => (
    <Toast
      id={id}
      title={toast.title}
      description={toast.description}
      variant={toast.variant}
      actions={toast.actions}
      quickAction={toast.quickAction}
    />
  ));
}

export function Toast(props: ToastProps) {
  const { variant = "info" } = props;

  if (variant === "info") {
    return <InfoToast {...props} />;
  }

  if (variant === "success") {
    return <SuccessToast {...props} />;
  }

  if (variant === "warning") {
    return <WarningToast {...props} />;
  }

  if (variant === "error") {
    return <ErrorToast {...props} />;
  }
}

export const InfoToast = (props: Omit<ToastProps, "variant">) => {
  const { title, description, bulletPoints, actions, quickAction } = props;

  return (
    <div className="rounded-md bg-blue-50 p-4 dark:bg-blue-500/10 dark:outline dark:outline-blue-500/20">
      <div className="flex">
        <div className="shrink-0">
          <Info aria-hidden="true" className="size-5 text-blue-400" />
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200">
            {title}
          </h3>
          {description && (
            <div className="mt-2 text-sm text-blue-700 dark:text-blue-200/85">
              <p>{description}</p>
            </div>
          )}
          {bulletPoints && (
            <div className="mt-2 text-sm text-blue-700 dark:text-blue-200/80">
              <ul className="list-disc space-y-1 pl-5">
                {bulletPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {actions && (
            <div className="mt-4">
              <div className="-mx-2 -my-1.5 flex">
                {actions.map((action, index) => (
                  <button
                    key={index}
                    type="button"
                    className="flex justify-center items-center gap-4 cursor-pointer rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-blue-800 hover:bg-blue-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600 dark:bg-transparent dark:text-blue-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-blue-500/50"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.icon ? action.icon : null}
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {quickAction && (
          <div className="ml-auto pl-3">
            <div className="-mx-1.5 -my-1.5">
              <button
                type="button"
                className="inline-flex rounded-md bg-blue-50 p-1.5 text-blue-500 hover:bg-blue-100 focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 focus-visible:ring-offset-blue-50 focus-visible:outline-hidden dark:bg-transparent dark:text-blue-400 dark:hover:bg-blue-500/10 dark:focus-visible:ring-blue-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-blue-900"
              >
                <span className="sr-only">{quickAction.label}</span>
                {quickAction.icon ?? (
                  <X aria-hidden="true" className="size-5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const SuccessToast = (props: Omit<ToastProps, "variant">) => {
  const { title, description, bulletPoints, actions, quickAction } = props;

  return (
    <div className="rounded-md bg-green-50 p-4 dark:bg-green-500/10 dark:outline dark:outline-green-500/20">
      <div className="flex">
        <div className="shrink-0">
          <CheckCircle aria-hidden="true" className="size-5 text-green-400" />
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-green-800 dark:text-green-200">
            {title}
          </h3>
          {description && (
            <div className="mt-2 text-sm text-green-700 dark:text-green-200/85">
              <p>{description}</p>
            </div>
          )}
          {bulletPoints && (
            <div className="mt-2 text-sm text-green-700 dark:text-green-200/80">
              <ul className="list-disc space-y-1 pl-5">
                {bulletPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {actions && (
            <div className="mt-4">
              <div className="-mx-2 -my-1.5 flex">
                {actions.map((action, index) => (
                  <button
                    key={index}
                    type="button"
                    className="flex justify-center items-center gap-4 cursor-pointer rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 dark:bg-transparent dark:text-green-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-green-500/50"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.icon ? action.icon : null}
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {quickAction && (
          <div className="ml-auto pl-3">
            <div className="-mx-1.5 -my-1.5">
              <button
                type="button"
                className="inline-flex rounded-md bg-green-50 p-1.5 text-green-500 hover:bg-green-100 focus-visible:ring-2 focus-visible:ring-green-600 focus-visible:ring-offset-2 focus-visible:ring-offset-green-50 focus-visible:outline-hidden dark:bg-transparent dark:text-green-400 dark:hover:bg-green-500/10 dark:focus-visible:ring-green-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-green-900"
              >
                <span className="sr-only">{quickAction.label}</span>
                {quickAction.icon ?? (
                  <X aria-hidden="true" className="size-5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const WarningToast = (props: Omit<ToastProps, "variant">) => {
  const { title, description, bulletPoints, actions, quickAction } = props;

  return (
    <div className="rounded-md bg-yellow-50 p-4 dark:bg-yellow-500/10 dark:outline dark:outline-yellow-500/15">
      <div className="flex">
        <div className="shrink-0">
          <TriangleAlert
            aria-hidden="true"
            className="size-5 text-yellow-400 dark:text-yellow-300"
          />
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-green-800 dark:text-green-200">
            {title}
          </h3>
          {description && (
            <div className="mt-2 text-sm text-green-700 dark:text-green-200/85">
              <p>{description}</p>
            </div>
          )}
          {bulletPoints && (
            <div className="mt-2 text-sm text-green-700 dark:text-green-200/80">
              <ul className="list-disc space-y-1 pl-5">
                {bulletPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {actions && (
            <div className="mt-4">
              <div className="-mx-2 -my-1.5 flex">
                {actions.map((action, index) => (
                  <button
                    key={index}
                    type="button"
                    className="flex justify-center items-center gap-4 cursor-pointer rounded-md bg-green-50 px-2 py-1.5 text-sm font-medium text-green-800 hover:bg-green-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green-600 dark:bg-transparent dark:text-green-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-green-500/50"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.icon ? action.icon : null}
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {quickAction && (
          <div className="ml-auto pl-3">
            <div className="-mx-1.5 -my-1.5">
              <button
                type="button"
                className="inline-flex rounded-md bg-yellow-50 p-1.5 text-yellow-500 hover:bg-yellow-100 focus-visible:ring-2 focus-visible:ring-yellow-600 focus-visible:ring-offset-2 focus-visible:ring-offset-yellow-50 focus-visible:outline-hidden dark:bg-transparent dark:text-yellow-400 dark:hover:bg-yellow-500/10 dark:focus-visible:ring-yellow-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-yellow-900"
              >
                <span className="sr-only">{quickAction.label}</span>
                {quickAction.icon ?? (
                  <X aria-hidden="true" className="size-5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export const ErrorToast = (props: Omit<ToastProps, "variant">) => {
  const { title, description, bulletPoints, actions, quickAction } = props;

  return (
    <div className="rounded-md bg-red-50 p-4 dark:bg-red-500/15 dark:outline dark:outline-red-500/25">
      <div className="flex">
        <div className="shrink-0">
          <CircleX aria-hidden="true" className="size-5 text-red-400" />
        </div>
        <div className="ml-3">
          <h3 className="text-sm font-medium text-red-800 dark:text-red-200">
            {title}
          </h3>
          {description && (
            <div className="mt-2 text-sm text-red-700 dark:text-red-200/85">
              <p>{description}</p>
            </div>
          )}
          {bulletPoints && (
            <div className="mt-2 text-sm text-red-700 dark:text-red-200/80">
              <ul className="list-disc space-y-1 pl-5">
                {bulletPoints.map((point, index) => (
                  <li key={index}>{point}</li>
                ))}
              </ul>
            </div>
          )}
          {actions && (
            <div className="mt-4">
              <div className="-mx-2 -my-1.5 flex">
                {actions.map((action, index) => (
                  <button
                    key={index}
                    type="button"
                    className="flex justify-center items-center gap-4 cursor-pointer rounded-md bg-red-50 px-2 py-1.5 text-sm font-medium text-red-800 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600 dark:bg-transparent dark:text-red-200 dark:hover:bg-white/10 dark:focus-visible:outline-offset-1 dark:focus-visible:outline-red-500/50"
                    onClick={action.onClick}
                    disabled={action.disabled}
                  >
                    {action.icon ? action.icon : null}
                    <span>{action.label}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {quickAction && (
          <div className="ml-auto pl-3">
            <div className="-mx-1.5 -my-1.5">
              <button
                type="button"
                className="inline-flex rounded-md bg-red-50 p-1.5 text-red-500 hover:bg-red-100 focus-visible:ring-2 focus-visible:ring-red-600 focus-visible:ring-offset-2 focus-visible:ring-offset-red-50 focus-visible:outline-hidden dark:bg-transparent dark:text-red-400 dark:hover:bg-red-500/10 dark:focus-visible:ring-red-500 dark:focus-visible:ring-offset-1 dark:focus-visible:ring-offset-red-900"
              >
                <span className="sr-only">{quickAction.label}</span>
                {quickAction.icon ?? (
                  <X aria-hidden="true" className="size-5" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
