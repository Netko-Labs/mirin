import * as React from "react";
import { Avatar, AvatarFallback, AvatarImage } from "../../src/components/avatar.tsx";
import { Button } from "../../src/components/button.tsx";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemSeparator,
  ItemTitle,
} from "../../src/components/item.tsx";
import { PlusIcon } from "../../src/icons/index.ts";

const people = [
  {
    username: "shadcn",
    avatar: "https://github.com/shadcn.png",
    email: "shadcn@vercel.com",
  },
  {
    username: "maxleiter",
    avatar: "https://github.com/maxleiter.png",
    email: "maxleiter@vercel.com",
  },
  {
    username: "evilrabbit",
    avatar: "https://github.com/evilrabbit.png",
    email: "evilrabbit@vercel.com",
  },
];

export default function ItemGroupExample() {
  return (
    <div className="flex w-full max-w-md flex-col gap-6">
      <ItemGroup>
        {people.map((person, index) => (
          <React.Fragment key={person.username}>
            <Item>
              <ItemMedia>
                <Avatar>
                  <AvatarImage src={person.avatar} className="grayscale" />
                  <AvatarFallback>{person.username.charAt(0)}</AvatarFallback>
                </Avatar>
              </ItemMedia>
              <ItemContent className="gap-1">
                <ItemTitle>{person.username}</ItemTitle>
                <ItemDescription>{person.email}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button variant="ghost" size="icon" className="rounded-full">
                  <PlusIcon />
                </Button>
              </ItemActions>
            </Item>
            {index !== people.length - 1 && <ItemSeparator />}
          </React.Fragment>
        ))}
      </ItemGroup>
    </div>
  );
}
